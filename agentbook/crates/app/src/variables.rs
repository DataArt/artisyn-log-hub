//! The Variables dialog (FR-12): per shared folder, NAME / VALUE / FROM with the project default,
//! override and reset, added variables, Hidden values (credential store), "Only for one laptop"
//! sub-rows, and the warnings. Saving sends one `SetVariables` command.

use agentbook_core::variables::{is_valid_name, starts_hidden};
use agentbook_engine::{Command, Secret, Snapshot, VarEdit, VarInput, VarShown};
use egui::{Align, Layout, RichText, Ui};

use crate::app::{App, folder_name, plural};
use crate::theme;

#[derive(Debug, Clone)]
struct Val {
    /// The typed value (empty for a stored Hidden value nobody retyped).
    text: String,
    hidden: bool,
    /// A Hidden value is already in the credential store.
    stored: bool,
}

impl Val {
    fn from_shown(shown: &VarShown) -> Self {
        match shown {
            VarShown::Plain(t) => Self {
                text: t.clone(),
                hidden: false,
                stored: false,
            },
            VarShown::Hidden => Self {
                text: String::new(),
                hidden: true,
                stored: true,
            },
        }
    }

    fn input(&self) -> VarInput {
        match (self.hidden, self.text.is_empty(), self.stored) {
            (true, false, _) => VarInput::Hidden(Some(Secret(self.text.clone()))),
            (true, true, true) => VarInput::Hidden(None),
            _ => VarInput::Plain(self.text.clone()),
        }
    }
}

#[derive(Debug, Clone)]
struct LaptopVal {
    laptop: String,
    val: Val,
}

#[derive(Debug, Clone)]
struct Row {
    name: String,
    /// Added in this dialog (the name is editable).
    new: bool,
    project_default: Option<String>,
    /// A folder-wide setting exists (else the project default applies).
    set: bool,
    val: Val,
    laptops: Vec<LaptopVal>,
    removed: bool,
}

/// The folder-wide edits and, per laptop, its "Only for one laptop" edits.
type Edits = (Vec<VarEdit>, Vec<(String, Vec<VarEdit>)>);

/// The dialog's editable copy.
pub struct VarDraft {
    folder: String,
    rows: Vec<Row>,
    error: Option<String>,
    /// Whether a save was sent (the dialog then closes).
    saving: Option<u64>,
}

impl VarDraft {
    pub fn new(snap: &Snapshot, folder: &str) -> Self {
        let rows = snap
            .folder(folder)
            .map(|fv| {
                fv.variables
                    .iter()
                    .map(|v| {
                        let (set, val) = match &v.folder {
                            Some(shown) => (true, Val::from_shown(shown)),
                            None => (
                                false,
                                Val {
                                    text: v.project_default.clone().unwrap_or_default(),
                                    hidden: starts_hidden(&v.name),
                                    stored: false,
                                },
                            ),
                        };
                        Row {
                            name: v.name.clone(),
                            new: false,
                            project_default: v.project_default.clone(),
                            set,
                            val,
                            laptops: v
                                .laptops
                                .iter()
                                .map(|(id, shown)| LaptopVal {
                                    laptop: id.clone(),
                                    val: Val::from_shown(shown),
                                })
                                .collect(),
                            removed: false,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            folder: folder.to_string(),
            rows,
            error: None,
            saving: None,
        }
    }

    /// The edits, or the first problem found.
    fn edits(&self, laptops: &[String]) -> Result<Edits, String> {
        let mut folder = Vec::new();
        let mut per: Vec<(String, Vec<VarEdit>)> =
            laptops.iter().map(|l| (l.clone(), Vec::new())).collect();
        let mut seen: Vec<&str> = Vec::new();
        for row in self.rows.iter().filter(|r| !r.removed) {
            let name = row.name.trim();
            if row.new && name.is_empty() {
                continue;
            }
            if !is_valid_name(name) {
                return Err(format!(
                    "\"{name}\" is not a valid name: use letters, digits and _, not starting with \
                     a digit."
                ));
            }
            if seen.contains(&name) {
                return Err(format!("The variable {name} is listed twice."));
            }
            seen.push(name);
            if row.set || row.new {
                folder.push(VarEdit {
                    name: name.to_string(),
                    value: row.val.input(),
                });
            }
            let mut used: Vec<&str> = Vec::new();
            for lv in &row.laptops {
                if used.contains(&lv.laptop.as_str()) {
                    return Err(format!(
                        "{name} has two \"Only for one laptop\" values for the same laptop."
                    ));
                }
                used.push(&lv.laptop);
                if let Some((_, edits)) = per.iter_mut().find(|(l, _)| l == &lv.laptop) {
                    edits.push(VarEdit {
                        name: name.to_string(),
                        value: lv.val.input(),
                    });
                }
            }
        }
        Ok((folder, per))
    }
}

/// One VALUE cell: a text field (masked when Hidden) and the Hidden toggle.
fn value_cell(
    ui: &mut Ui,
    val: &mut Val,
    hint: &str,
    id: impl std::hash::Hash + std::fmt::Debug,
) -> bool {
    let mut changed = false;
    let hint = if val.hidden && val.stored && val.text.is_empty() {
        "•••••••• (kept; type to replace)".to_string()
    } else {
        hint.to_string()
    };
    let hint_color = if val.text.is_empty() {
        theme::AMBER_TEXT
    } else {
        theme::FAINT
    };
    let r = ui.add(
        egui::TextEdit::singleline(&mut val.text)
            .id_salt(("value", &id))
            .password(val.hidden)
            .hint_text(RichText::new(hint).color(hint_color))
            .desired_width(230.0),
    );
    changed |= r.changed();
    let mut hidden = val.hidden;
    if ui
        .checkbox(&mut hidden, "🔒 Hidden")
        .on_hover_text("Masked here and kept in Windows Credential Manager, not in files.")
        .changed()
    {
        val.hidden = hidden;
        changed = true;
    }
    changed
}

pub fn show(app: &mut App, ctx: &egui::Context, snap: &Snapshot, d: &mut VarDraft) -> bool {
    let Some(fv) = snap.folder(&d.folder) else {
        return false;
    };
    if let Some(id) = d.saving {
        // Closed as soon as the engine has the change; a failure shows as a banner.
        let _ = id;
        return false;
    }
    let laptops = App::laptops_of(snap, &d.folder);
    let laptop_ids: Vec<String> = laptops.iter().map(|l| l.laptop.id.clone()).collect();
    let laptop_name = |id: &str| {
        laptops
            .iter()
            .find(|l| l.laptop.id == id)
            .map(|l| l.laptop.name.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let sessions: u32 = laptops.iter().map(|l| l.sessions).sum();
    let mut save = false;
    let mut cancel = false;
    let mut closed = false;
    let response = egui::Modal::new(egui::Id::new("variables"))
        .frame(
            egui::Frame::new()
                .fill(egui::Color32::WHITE)
                .stroke(egui::Stroke::new(1.0, theme::BORDER_STRONG))
                .corner_radius(10)
                .inner_margin(egui::Margin::symmetric(24, 18)),
        )
        .show(ctx, |ui| {
            ui.set_width(720.0);
            ui.horizontal(|ui| {
                ui.label(theme::strong(
                    format!("🔑 Variables — {}", folder_name(&fv.folder)),
                    17.0,
                ));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui.add(egui::Button::new("✕").frame(false)).clicked() {
                        closed = true;
                    }
                });
            });
            ui.label(theme::muted(
                "Programs on every laptop of this shared folder see these values.",
            ));
            ui.label(theme::muted(
                "Defaults come from the project (.devcontainer → containerEnv / remoteEnv).",
            ));
            ui.add_space(8.0);
            egui::ScrollArea::vertical()
                .max_height(ctx.content_rect().height() * 0.5)
                .show(ui, |ui| {
                    egui::Grid::new("vars")
                        .num_columns(4)
                        .min_col_width(60.0)
                        .spacing([12.0, 8.0])
                        .show(ui, |ui| {
                            ui.label(theme::caption("Name"));
                            ui.label(theme::caption("Value"));
                            ui.label(theme::caption("From"));
                            ui.label("");
                            ui.end_row();
                            for (i, row) in d.rows.iter_mut().enumerate() {
                                if row.removed {
                                    continue;
                                }
                                if row.new {
                                    let r = ui.add_sized(
                                        [160.0, 24.0],
                                        egui::TextEdit::singleline(&mut row.name)
                                            .id_salt(("name", i))
                                            .hint_text("NAME"),
                                    );
                                    if r.changed() && !row.val.stored {
                                        row.val.hidden = starts_hidden(&row.name);
                                    }
                                } else {
                                    ui.label(RichText::new(&row.name).monospace().strong());
                                }
                                let needs = !row.set
                                    && row.project_default.as_deref().unwrap_or("").is_empty();
                                ui.horizontal(|ui| {
                                    let hint = if needs { "needs a value" } else { "" };
                                    if value_cell(ui, &mut row.val, hint, ("row", i)) {
                                        row.set = true;
                                    }
                                });
                                ui.horizontal(|ui| {
                                    let from = match (row.set || row.new, &row.project_default) {
                                        (true, Some(_)) => "you",
                                        (true, None) => "added by you",
                                        (false, Some(dv)) if dv.is_empty() => "project (empty)",
                                        _ => "project default",
                                    };
                                    ui.label(theme::small(from));
                                    if row.set
                                        && let Some(dv) = &row.project_default
                                        && theme::link(ui, "↺ project default")
                                            .on_hover_text("Use the project's value again")
                                            .clicked()
                                    {
                                        row.set = false;
                                        row.val = Val {
                                            text: dv.clone(),
                                            hidden: starts_hidden(&row.name),
                                            stored: false,
                                        };
                                    }
                                });
                                ui.horizontal(|ui| {
                                    if row.project_default.is_none()
                                        && ui
                                            .small_button("✕")
                                            .on_hover_text("Remove this variable")
                                            .clicked()
                                    {
                                        row.removed = true;
                                    }
                                    let free = laptop_ids
                                        .iter()
                                        .find(|l| !row.laptops.iter().any(|x| &x.laptop == *l));
                                    if let Some(free) = free
                                        && theme::link(ui, "+ one laptop")
                                            .on_hover_text(
                                                "Give one laptop its own value (an exception)",
                                            )
                                            .clicked()
                                    {
                                        row.laptops.push(LaptopVal {
                                            laptop: free.clone(),
                                            val: Val {
                                                text: String::new(),
                                                hidden: row.val.hidden,
                                                stored: false,
                                            },
                                        });
                                    }
                                });
                                ui.end_row();
                                let mut drop = None;
                                for (j, lv) in row.laptops.iter_mut().enumerate() {
                                    ui.label(theme::small("   ↳ Only for one laptop"));
                                    ui.horizontal(|ui| {
                                        value_cell(ui, &mut lv.val, "", ("laptop", i, j));
                                    });
                                    egui::ComboBox::from_id_salt(("laptop-of", i, j))
                                        .selected_text(laptop_name(&lv.laptop))
                                        .show_ui(ui, |ui| {
                                            for id in &laptop_ids {
                                                ui.selectable_value(
                                                    &mut lv.laptop,
                                                    id.clone(),
                                                    laptop_name(id),
                                                );
                                            }
                                        });
                                    if ui
                                        .small_button("✕")
                                        .on_hover_text(
                                            "Remove; the laptop uses the folder's value again",
                                        )
                                        .clicked()
                                    {
                                        drop = Some(j);
                                    }
                                    ui.end_row();
                                }
                                if let Some(j) = drop {
                                    row.laptops.remove(j);
                                }
                            }
                        });
                });
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                if theme::secondary(ui, "+ Add a variable").clicked() {
                    d.rows.push(Row {
                        name: String::new(),
                        new: true,
                        project_default: None,
                        set: true,
                        val: Val {
                            text: String::new(),
                            hidden: false,
                            stored: false,
                        },
                        laptops: Vec::new(),
                        removed: false,
                    });
                }
                ui.label(theme::small(
                    "Names with TOKEN, PAT, SECRET, PASSWORD or KEY start as Hidden.",
                ));
            });
            ui.label(theme::small(
                "Values apply to all laptops. Exception: on a value, use \"+ one laptop\" to give \
                 one laptop its own.",
            ));
            ui.add_space(6.0);
            theme::warning_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(
                    RichText::new(
                        "⚠ The agent and every program on these laptops can read all values, \
                         hidden ones too.",
                    )
                    .color(theme::AMBER_TEXT),
                );
                ui.label(theme::small(
                    "Hidden values are kept in Windows Credential Manager and are not shown again.",
                ));
            });
            ui.add_space(4.0);
            ui.label(theme::small(if sessions == 0 {
                "Changes apply to new Desktop sessions. No restart.".to_string()
            } else {
                format!(
                    "Changes apply to new Desktop sessions. {} keep the old values. No restart.",
                    plural(sessions as usize, "open session", "open sessions")
                )
            }));
            if let Some(e) = &d.error {
                ui.label(RichText::new(e).color(theme::RED));
            }
            ui.add_space(8.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::primary(ui, "Save").clicked() {
                    save = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        });
    if response.should_close() {
        closed = true;
    }
    if save {
        match d.edits(&laptop_ids) {
            Ok((vars, laptop_vars)) => {
                d.saving = app.run(Command::SetVariables {
                    folder: d.folder.clone(),
                    vars,
                    laptop_vars,
                });
                return false;
            }
            Err(e) => d.error = Some(e),
        }
    }
    !(closed || cancel)
}
