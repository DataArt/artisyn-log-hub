//! The dialogs of the wireframes: Get a laptop and Another laptop like this (FR-8, FR-11, FR-12),
//! the on-the-go consequences dialog (give a folder, change its mode, take it away, Update laptop,
//! Locate folder), the whole-disk confirmation, Sleep, Remove laptop and Remove folder, the
//! `.claude/` chooser, Rename and the Update progress. Variables live in `variables.rs`.

use agentbook_core::broad_folder::Breadth;
use agentbook_core::paths::host_basename;
use agentbook_core::state::{EquipmentKind, VarValue};
use agentbook_engine::{ActionState, Command, GivenInput, RunState, Snapshot};
use egui::{Align, Key, Layout, RichText, Ui};

use crate::app::{App, PickFor, Screen, equipment_words, folder_name, plural};
use crate::theme;
use crate::variables::VarDraft;

/// "Get a laptop" / "Another laptop like this".
#[derive(Debug, Clone)]
pub struct Draft {
    pub folder: String,
    pub name: String,
    pub given: Vec<GivenInput>,
    /// "Another laptop like this": the source laptop (id, name).
    pub like: Option<(String, String)>,
    /// The source laptop's "Only for one laptop" variables: (name, hidden).
    pub copied_vars: Vec<(String, bool)>,
    /// A whole-disk / home folder was confirmed.
    pub confirmed_broad: bool,
    focus: bool,
}

/// The on-the-go change a consequences dialog confirms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsKind {
    Give {
        path: String,
        read_only: bool,
        confirmed_broad: bool,
    },
    SetMode {
        path: String,
        read_only: bool,
    },
    RemoveGiven {
        path: String,
    },
    Update,
    Locate {
        folder: String,
        path: String,
        confirmed_broad: bool,
    },
}

/// The FR-8 consequences dialog.
#[derive(Debug, Clone)]
pub struct Cons {
    /// The laptop changed (`None` for Locate folder, which changes every laptop of the folder).
    pub laptop: Option<String>,
    pub kind: ConsKind,
}

/// What the whole-disk confirmation continues with.
#[derive(Debug, Clone)]
pub enum BroadThen {
    AddFolder,
    Draft(Box<Draft>),
    OnTheGo(Box<Cons>),
    Locate(String),
}

pub enum Dialog {
    GetLaptop(Draft),
    Consequences(Cons),
    WholeDisk { path: String, then: BroadThen },
    Sleep { laptop: String },
    RemoveLaptop { laptop: String },
    RemoveFolder { folder: String },
    Variables(VarDraft),
    Update { laptop: String, action: u64 },
    ClaudeDir { folder: String, choice: String },
    Rename { laptop: String, name: String },
    Ports(PortsDraft),
    About,
}

impl Dialog {
    /// "Ports…" with the laptop's current forwards.
    pub fn ports(lv: &agentbook_engine::LaptopView) -> Dialog {
        let mut rows: Vec<(String, String)> = lv
            .ports
            .iter()
            .map(|p| (p.port.to_string(), p.host.to_string()))
            .collect();
        if rows.is_empty() {
            rows.push((String::new(), String::new()));
        }
        Dialog::Ports(PortsDraft {
            laptop: lv.laptop.id.clone(),
            rows,
            defaults: false,
            error: None,
        })
    }

    pub fn get_laptop(app: &App, folder: &str) -> Option<Dialog> {
        let name = app.engine()?.suggest_name(folder);
        Some(Dialog::GetLaptop(Draft {
            folder: folder.to_string(),
            name,
            given: Vec::new(),
            like: None,
            copied_vars: Vec::new(),
            confirmed_broad: false,
            focus: true,
        }))
    }

    /// "Another laptop like this", optionally with one more given folder (the calmer option of
    /// "Give a folder now").
    pub fn like_this(app: &App, laptop: &str, add: Option<GivenInput>) -> Option<Dialog> {
        let engine = app.engine()?;
        let d = engine.like_this(laptop)?;
        let source = engine.snapshot().laptop(laptop)?.laptop.name.clone();
        let mut given = d.given;
        let mut confirmed_broad = given
            .iter()
            .any(|g| app.breadth(&g.path).needs_confirmation());
        if let Some(g) = add {
            confirmed_broad |= app.breadth(&g.path).needs_confirmation();
            if !given.iter().any(|x| x.path == g.path) {
                given.push(g);
            }
        }
        Some(Dialog::GetLaptop(Draft {
            folder: d.folder,
            name: d.name,
            given,
            like: Some((laptop.to_string(), source)),
            copied_vars: d.copied_vars,
            confirmed_broad,
            focus: true,
        }))
    }

    pub fn consequences(laptop: String, kind: ConsKind) -> Dialog {
        Dialog::Consequences(Cons {
            laptop: Some(laptop),
            kind,
        })
    }

    pub fn whole_disk(path: String, then: BroadThen) -> Dialog {
        Dialog::WholeDisk { path, then }
    }

    pub fn variables(app: &App, folder: &str) -> Dialog {
        let snap = app.engine().map(|e| e.snapshot()).unwrap_or_default();
        Dialog::Variables(VarDraft::new(&snap, folder))
    }
}

/// A folder chosen in the OS picker for the open dialog.
pub fn picked(app: &mut App, purpose: PickFor, path: String) {
    match purpose {
        PickFor::Draft => {
            if let Some(Dialog::GetLaptop(d)) = app.dialog.take() {
                add_given(app, d, path);
            }
        }
        PickFor::OnTheGo => {
            if let Some(Dialog::Consequences(c)) = app.dialog.take() {
                set_on_the_go(app, c, path);
            }
        }
        PickFor::Locate(folder) => locate(app, folder, path, false),
        PickFor::AddFolder => app.add_folder(&path),
    }
}

/// A folder dropped on the window while a dialog is open.
pub fn dropped(app: &mut App, path: String) {
    match app.dialog.take() {
        Some(Dialog::GetLaptop(d)) => add_given(app, d, path),
        Some(Dialog::Consequences(c)) if matches!(c.kind, ConsKind::Give { .. }) => {
            set_on_the_go(app, c, path)
        }
        other => app.dialog = other,
    }
}

fn add_given(app: &mut App, mut d: Draft, path: String) {
    if d.given.iter().any(|g| g.path == path) {
        app.dialog = Some(Dialog::GetLaptop(d));
        return;
    }
    if app.breadth(&path).needs_confirmation() && !d.confirmed_broad {
        app.dialog = Some(Dialog::whole_disk(path, BroadThen::Draft(Box::new(d))));
        return;
    }
    d.given.push(GivenInput {
        path,
        read_only: false,
    });
    app.dialog = Some(Dialog::GetLaptop(d));
}

fn set_on_the_go(app: &mut App, mut c: Cons, new_path: String) {
    let broad = app.breadth(&new_path).needs_confirmation();
    if let ConsKind::Give {
        path,
        confirmed_broad,
        ..
    } = &mut c.kind
    {
        *path = new_path.clone();
        *confirmed_broad = false;
    }
    app.dialog = Some(if broad {
        Dialog::whole_disk(new_path, BroadThen::OnTheGo(Box::new(c)))
    } else {
        Dialog::Consequences(c)
    });
}

fn locate(app: &mut App, folder: String, path: String, confirmed: bool) {
    if !confirmed && app.breadth(&path).needs_confirmation() {
        app.dialog = Some(Dialog::whole_disk(path, BroadThen::Locate(folder)));
        return;
    }
    let has_laptops = app
        .engine()
        .map(|e| {
            e.snapshot()
                .laptops
                .iter()
                .any(|l| l.laptop.folder_id == folder)
        })
        .unwrap_or(false);
    if has_laptops {
        app.dialog = Some(Dialog::Consequences(Cons {
            laptop: None,
            kind: ConsKind::Locate {
                folder,
                path,
                confirmed_broad: confirmed,
            },
        }));
    } else {
        app.run(Command::LocateFolder {
            folder,
            path,
            confirm_broad: confirmed,
        });
    }
}

/// A modal with a title row and a close button. Returns the content's result and whether it
/// was closed (✕ or Escape).
fn modal<R>(
    ctx: &egui::Context,
    id: &str,
    width: f32,
    title: RichText,
    content: impl FnOnce(&mut Ui) -> R,
) -> (R, bool) {
    let mut closed = false;
    let response = egui::Modal::new(egui::Id::new(id))
        .frame(
            egui::Frame::new()
                .fill(egui::Color32::WHITE)
                .stroke(egui::Stroke::new(1.0, theme::BORDER_STRONG))
                .corner_radius(10)
                .inner_margin(egui::Margin::symmetric(24, 18)),
        )
        .show(ctx, |ui| {
            ui.set_width(width);
            ui.horizontal(|ui| {
                ui.label(title);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui
                        .add(egui::Button::new(RichText::new("✕").size(15.0)).frame(false))
                        .clicked()
                    {
                        closed = true;
                    }
                });
            });
            ui.add_space(6.0);
            content(ui)
        });
    if response.should_close() {
        closed = true;
    }
    (response.inner, closed)
}

fn title(text: impl Into<String>) -> RichText {
    theme::strong(text, 17.0)
}

/// Shows the dialog; `false` closes it.
pub fn show(app: &mut App, ctx: &egui::Context, snap: &Snapshot, dialog: &mut Dialog) -> bool {
    match dialog {
        Dialog::GetLaptop(d) => get_laptop(app, ctx, snap, d),
        Dialog::Consequences(c) => consequences(app, ctx, snap, c),
        Dialog::WholeDisk { path, then } => whole_disk(app, ctx, path, then),
        Dialog::Sleep { laptop } => sleep(app, ctx, snap, laptop),
        Dialog::RemoveLaptop { laptop } => remove_laptop(app, ctx, snap, laptop),
        Dialog::RemoveFolder { folder } => remove_folder(app, ctx, snap, folder),
        Dialog::Variables(v) => crate::variables::show(app, ctx, snap, v),
        Dialog::Update { laptop, action } => update(app, ctx, snap, laptop, action),
        Dialog::ClaudeDir { folder, choice } => claude_dir(app, ctx, snap, folder, choice),
        Dialog::Rename { laptop, name } => rename(app, ctx, snap, laptop, name),
        Dialog::Ports(d) => ports(app, ctx, snap, d),
        Dialog::About => about(ctx),
    }
}

/// About AgentBook: the mascot at its desk, the version and what the app is.
fn about(ctx: &egui::Context) -> bool {
    const WIDTH: f32 = 520.0;
    let (close, closed) = modal(ctx, "about", WIDTH, title("About AgentBook"), |ui| {
        let picture = crate::icons::Picture::About;
        let texture = crate::icons::texture(ui.ctx(), picture);
        let size = egui::vec2(WIDTH, WIDTH / crate::icons::aspect(picture));
        ui.add(egui::Image::new((texture.id(), size)).corner_radius(8));
        ui.add_space(12.0);
        ui.label(theme::strong("AgentBook", 22.0));
        ui.label(theme::muted(format!(
            "Version {}",
            env!("CARGO_PKG_VERSION")
        )));
        ui.add_space(8.0);
        ui.label(
            "A virtual laptop for the agent, inside your computer. Claude Desktop connects to \
             it over SSH and sees only the folders you share with it.",
        );
        ui.add_space(8.0);
        ui.label(theme::small(format!(
            "© {}. MIT license.",
            env!("CARGO_PKG_AUTHORS")
        )));
        ui.add_space(14.0);
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            theme::primary(ui, "Close").clicked()
        })
        .inner
    });
    !(close || closed)
}

fn mode_combo(ui: &mut Ui, id: impl egui::AsIdSalt, read_only: &mut bool) {
    let text = if *read_only {
        "👁 View only"
    } else {
        "✎ Can change"
    };
    egui::ComboBox::from_id_salt(id)
        .selected_text(text)
        .show_ui(ui, |ui| {
            ui.selectable_value(read_only, false, "✎ Can change");
            ui.selectable_value(read_only, true, "👁 View only");
        });
}

fn get_laptop(app: &mut App, ctx: &egui::Context, snap: &Snapshot, d: &mut Draft) -> bool {
    let Some(fv) = snap.folder(&d.folder) else {
        return false;
    };
    let fname = folder_name(&fv.folder);
    let heading = match &d.like {
        Some((_, n)) => format!("Another laptop like \"{n}\""),
        None => "Get a laptop".to_string(),
    };
    let mut submit = false;
    let mut cancel = false;
    let mut pick = false;
    let (_, closed) = modal(ctx, "get-laptop", 520.0, title(heading), |ui| {
        ui.label(theme::muted(match &d.like {
            Some(_) => {
                "Same setup, fresh laptop: nothing the agent installed is copied.".to_string()
            }
            None => format!("It sees the shared folder {fname}. You can rename it later."),
        }));
        ui.add_space(8.0);
        ui.label(theme::strong("Name", 13.5));
        let r = ui.add(
            egui::TextEdit::singleline(&mut d.name)
                .desired_width(f32::INFINITY)
                .char_limit(80),
        );
        if d.focus {
            r.request_focus();
            d.focus = false;
        }
        if r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
            submit = true;
        }
        let duplicate = App::laptops_of(snap, &d.folder)
            .iter()
            .any(|l| l.laptop.name.trim().eq_ignore_ascii_case(d.name.trim()));
        ui.label(theme::small(if duplicate {
            "Another laptop of this folder has this name — that is allowed, but a different one \
             is easier to tell apart."
        } else {
            "Suggested name; type any text. A duplicate name gets a short note."
        }));
        ui.add_space(8.0);
        match &d.like {
            Some((_, n)) => {
                ui.label(theme::strong(
                    format!("Copied from \"{n}\" — change anything"),
                    13.5,
                ));
                ui.label(format!("⇄ Shared folder: {fname}"));
            }
            None => {
                ui.label(theme::strong(
                    "Give folders (optional — best done now, no restart later)",
                    13.5,
                ));
            }
        }
        let mut remove = None;
        for (i, g) in d.given.iter_mut().enumerate() {
            ui.horizontal(|ui| {
                ui.add(egui::Label::new(format!("📁 {}", g.path)).truncate());
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui
                        .small_button("✕")
                        .on_hover_text("Do not give this folder")
                        .clicked()
                    {
                        remove = Some(i);
                    }
                    mode_combo(ui, ("draft-mode", i), &mut g.read_only);
                });
            });
        }
        if let Some(i) = remove {
            d.given.remove(i);
        }
        if d.like.is_some() {
            ui.label(theme::small(format!(
                "Equipment: {}",
                equipment_words(&fv.folder)
            )));
        }
        if theme::link(ui, "📁+ Add a folder…").clicked() {
            pick = true;
        }
        ui.add_space(6.0);
        if d.given.iter().any(|g| !g.read_only) {
            ui.label(theme::small(
                "The agent works on the real folders; it could change or delete files there.",
            ));
        }
        if d.like.is_none() {
            let project = fv.folder.equipment.kind == EquipmentKind::Project;
            ui.label(theme::small(if project {
                "Equipment: from the project (.devcontainer) · first start builds it."
            } else {
                "Equipment: standard (Ubuntu LTS with git, curl, Node.js)."
            }));
            ui.label(theme::small(
                "The first time you open a laptop, Claude asks whether you trust it — once.",
            ));
        } else {
            ui.label(theme::small(
                "Not copied: programs the agent installed, open sessions, chat history.",
            ));
            ui.label(theme::small(
                "Both laptops work on the same shared folder — give them different jobs.",
            ));
        }
        if fv.folder.equipment.kind == EquipmentKind::Project && !fv.equipment.exposures.is_empty()
        {
            theme::warning_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(
                    RichText::new("⚠ Equipment opens your computer")
                        .color(theme::AMBER_TEXT)
                        .strong(),
                );
                for e in &fv.equipment.exposures {
                    ui.label(theme::small(&e.text));
                }
            });
        }
        if let Some((src, src_name)) = &d.like
            && !d.copied_vars.is_empty()
        {
            let source = snap.laptop(src);
            theme::warning_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                let n = d.copied_vars.len();
                let verb = if n == 1 { "is" } else { "are" };
                let _ = verb;
                ui.label(
                    RichText::new(format!(
                        "⚠ {} set only for \"{src_name}\" will be copied:",
                        plural(n, "variable", "variables")
                    ))
                    .color(theme::AMBER_TEXT)
                    .strong(),
                );
                let shown: Vec<String> = d
                    .copied_vars
                    .iter()
                    .map(|(name, hidden)| {
                        if *hidden {
                            return format!("{name} ••••••");
                        }
                        let value = source
                            .and_then(|l| l.laptop.laptop_vars.iter().find(|v| &v.name == name))
                            .and_then(|v| match &v.value {
                                VarValue::Plain(t) => Some(t.clone()),
                                _ => None,
                            })
                            .unwrap_or_default();
                        format!("{name}={value}")
                    })
                    .collect();
                ui.label(RichText::new(shown.join("   ")).monospace());
                ui.label(theme::small(
                    "Hidden values stay hidden. Change them later in Variables…",
                ));
            });
        }
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.label(theme::small("Enter = Get it and open"));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::primary(ui, "Get it and open ↗").clicked() {
                    submit = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        });
    });
    if pick {
        app.pick_folder(PickFor::Draft);
    }
    if submit {
        let name = if d.name.trim().is_empty() {
            app.engine()
                .map(|e| e.suggest_name(&d.folder))
                .unwrap_or_default()
        } else {
            d.name.trim().to_string()
        };
        app.run(Command::GetLaptop {
            folder: d.folder.clone(),
            name,
            given: d.given.clone(),
            copy_from: d.like.as_ref().map(|(id, _)| id.clone()),
            confirm_broad: d.confirmed_broad,
        });
        return false;
    }
    !(closed || cancel)
}

fn consequences(app: &mut App, ctx: &egui::Context, snap: &Snapshot, c: &mut Cons) -> bool {
    let affected: Vec<&agentbook_engine::LaptopView> = match (&c.laptop, &c.kind) {
        (Some(l), _) => snap.laptop(l).into_iter().collect(),
        (None, ConsKind::Locate { folder, .. }) => App::laptops_of(snap, folder),
        _ => Vec::new(),
    };
    let Some(first) = affected.first() else {
        if let ConsKind::Locate {
            folder,
            path,
            confirmed_broad,
        } = &c.kind
        {
            app.run(Command::LocateFolder {
                folder: folder.clone(),
                path: path.clone(),
                confirm_broad: *confirmed_broad,
            });
        }
        return false;
    };
    let name = first.laptop.name.clone();
    let sessions: u32 = affected.iter().map(|l| l.sessions).sum();
    let working = affected.iter().any(|l| l.run == RunState::Working);
    let (heading, confirm, intro) = match &c.kind {
        ConsKind::Give { .. } => (
            format!("Give \"{name}\" a folder now?"),
            "Restart and give folder".to_string(),
            "Giving it a folder now restarts it.",
        ),
        ConsKind::SetMode { path, read_only } => (
            format!(
                "Make {} {} for \"{name}\"?",
                host_basename(path),
                if *read_only {
                    "View only"
                } else {
                    "changeable"
                }
            ),
            "Restart and change".to_string(),
            "Changing a folder's mode restarts the laptop.",
        ),
        ConsKind::RemoveGiven { path } => (
            format!("Take {} away from \"{name}\"?", host_basename(path)),
            "Restart and take it away".to_string(),
            "Taking a folder away restarts the laptop. The folder itself stays untouched.",
        ),
        ConsKind::Update => (
            format!("Update \"{name}\"?"),
            "Update laptop".to_string(),
            "AgentBook builds the new Equipment first; if that fails, nothing changes. Then the \
             laptop restarts on it and keeps its home.",
        ),
        ConsKind::Locate { folder, .. } => (
            format!(
                "Point \"{}\" at the new location?",
                snap.folder(folder)
                    .map(|f| folder_name(&f.folder))
                    .unwrap_or_default()
            ),
            "Restart laptops and locate".to_string(),
            "Its laptops restart with the new folder and keep what the agent installed.",
        ),
    };
    let mut go = false;
    let mut cancel = false;
    let mut pick = false;
    let mut calmer = false;
    let (_, closed) = modal(ctx, "consequences", 540.0, title(heading), |ui| {
        let state = if affected.len() > 1 {
            format!("{} laptops of this folder", affected.len())
        } else if working {
            "This laptop is working.".to_string()
        } else {
            "This laptop is sleeping.".to_string()
        };
        let intro = if working || affected.len() > 1 {
            intro.to_string()
        } else {
            intro
                .replace("restarts it", "sets it up again")
                .replace("restarts the laptop", "sets the laptop up again")
        };
        ui.label(theme::muted(format!("{state} {intro}")));
        if let ConsKind::Give {
            path, read_only, ..
        } = &mut c.kind
        {
            ui.add_space(8.0);
            ui.label(theme::strong("Folder", 13.5));
            ui.horizontal(|ui| {
                ui.add(
                    egui::TextEdit::singleline(path)
                        .hint_text("Choose a folder, or drop one here")
                        .desired_width(270.0),
                );
                if theme::secondary(ui, "Browse…").clicked() {
                    pick = true;
                }
                mode_combo(ui, "give-mode", read_only);
            });
        }
        if let ConsKind::Locate { path, .. } = &c.kind {
            ui.label(theme::small(format!("New location: {path}")));
        }
        if matches!(c.kind, ConsKind::Update)
            && let Some(fv) = snap.folder(&first.laptop.folder_id)
            && fv.folder.equipment.kind == EquipmentKind::Project
            && !fv.equipment.exposures.is_empty()
        {
            theme::warning_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(
                    RichText::new("⚠ The new Equipment opens your computer")
                        .color(theme::AMBER_TEXT)
                        .strong(),
                );
                for e in &fv.equipment.exposures {
                    ui.label(theme::small(&e.text));
                }
            });
        }
        ui.add_space(8.0);
        theme::warning_box().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(theme::strong("What happens if you continue", 13.5));
            let warn = |ui: &mut Ui, text: String| {
                ui.label(RichText::new(format!("⚠ {text}")).color(theme::AMBER_TEXT));
            };
            if working {
                warn(ui, "The laptop restarts.".to_string());
            } else {
                warn(
                    ui,
                    "The laptop is set up again; it stays asleep.".to_string(),
                );
            }
            if sessions > 0 {
                warn(
                    ui,
                    format!(
                        "{}; the agent's current task is interrupted.",
                        disconnects(sessions)
                    ),
                );
            }
            if working {
                warn(
                    ui,
                    "Programs the agent left running (servers, builds) stop.".to_string(),
                );
            }
            warn(
                ui,
                "Programs the agent installed outside its home may be lost.".to_string(),
            );
            if let ConsKind::Give {
                read_only: false, ..
            } = &c.kind
            {
                warn(
                    ui,
                    "The agent works on the real folder; it could change or delete files there."
                        .to_string(),
                );
            }
        });
        if matches!(c.kind, ConsKind::Give { .. }) {
            ui.add_space(8.0);
            ui.label(theme::strong("Calmer option", 13.5));
            ui.label(theme::small(
                "Get another laptop like this one, with this folder added.",
            ));
            ui.label(theme::small(format!("\"{name}\" keeps working untouched.")));
        }
        ui.add_space(12.0);
        let ready = match &c.kind {
            ConsKind::Give { path, .. } => !path.trim().is_empty(),
            _ => true,
        };
        ui.horizontal(|ui| {
            if matches!(c.kind, ConsKind::Give { .. })
                && theme::secondary(ui, "⧉ Another laptop like this ↗").clicked()
            {
                calmer = true;
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui
                    .add_enabled_ui(ready, |ui| theme::primary(ui, confirm.clone()))
                    .inner
                    .clicked()
                {
                    go = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        });
        ui.add_space(4.0);
        ui.label(theme::small(
            "Cancel keeps everything as it is. Changing a folder's mode or taking a folder away \
             shows the same list.",
        ));
    });
    if pick {
        app.dialog = Some(Dialog::Consequences(c.clone()));
        app.pick_folder(PickFor::OnTheGo);
        return false;
    }
    let laptop = first.laptop.id.clone();
    if calmer {
        let add = match &c.kind {
            ConsKind::Give {
                path, read_only, ..
            } if !path.trim().is_empty() => Some(GivenInput {
                path: path.trim().to_string(),
                read_only: *read_only,
            }),
            _ => None,
        };
        app.dialog = Dialog::like_this(app, &laptop, add);
        return false;
    }
    if go {
        match c.kind.clone() {
            ConsKind::Give {
                path,
                read_only,
                confirmed_broad,
            } => {
                let path = path.trim().to_string();
                if !confirmed_broad && app.breadth(&path).needs_confirmation() {
                    app.dialog = Some(Dialog::whole_disk(
                        path,
                        BroadThen::OnTheGo(Box::new(c.clone())),
                    ));
                    return false;
                }
                app.run(Command::GiveFolder {
                    laptop,
                    path,
                    read_only,
                    confirm_broad: confirmed_broad,
                });
            }
            ConsKind::SetMode { path, read_only } => {
                app.run(Command::SetGivenMode {
                    laptop,
                    path,
                    read_only,
                });
            }
            ConsKind::RemoveGiven { path } => {
                app.run(Command::RemoveGiven { laptop, path });
            }
            ConsKind::Update => {
                if let Some(action) = app.run(Command::UpdateLaptop {
                    laptop: laptop.clone(),
                }) {
                    app.dialog = Some(Dialog::Update { laptop, action });
                }
            }
            ConsKind::Locate {
                folder,
                path,
                confirmed_broad,
            } => {
                app.run(Command::LocateFolder {
                    folder,
                    path,
                    confirm_broad: confirmed_broad,
                });
            }
        }
        return false;
    }
    !(closed || cancel)
}

fn whole_disk(app: &mut App, ctx: &egui::Context, path: &str, then: &BroadThen) -> bool {
    let breadth = app.breadth(path);
    let home = app.home_dir();
    let sharing = matches!(then, BroadThen::AddFolder | BroadThen::Locate(_));
    let heading = if sharing {
        "⚠ Share your whole disk with the agent?"
    } else {
        "⚠ Give the agent your whole disk?"
    };
    let mut confirm = false;
    let mut other = false;
    let (_, closed) = modal(ctx, "whole-disk", 470.0, title(heading), |ui| {
        let what = match breadth {
            Breadth::DriveRoot => format!("You chose {path} — a whole drive."),
            Breadth::Home => format!("You chose your home folder ({path})."),
            Breadth::HomeAncestor => {
                format!("You chose {path} — it contains your home folder ({home}).")
            }
            Breadth::Narrow => format!("You chose {path}."),
        };
        ui.label(what);
        ui.add_space(6.0);
        ui.label(
            "The agent would see everything in it: your home folder, other projects, saved \
             passwords and keys.",
        );
        ui.add_space(6.0);
        ui.label(theme::muted(format!(
            "Usually you want a smaller folder, for example {}.",
            std::path::Path::new(&home)
                .join("Desktop")
                .join("Q3 data")
                .display()
        )));
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let label = if sharing {
                    "Share the whole disk"
                } else {
                    "Give the whole disk"
                };
                if theme::danger(ui, label).clicked() {
                    confirm = true;
                }
                if theme::primary(ui, "Pick another folder").clicked() {
                    other = true;
                }
            });
        });
    });
    let restore = |app: &mut App| match then.clone() {
        BroadThen::Draft(d) => app.dialog = Some(Dialog::GetLaptop(*d)),
        BroadThen::OnTheGo(c) => app.dialog = Some(Dialog::Consequences(*c)),
        _ => {}
    };
    if confirm {
        match then.clone() {
            BroadThen::AddFolder => app.add_folder_confirmed(path, true),
            BroadThen::Draft(mut d) => {
                d.confirmed_broad = true;
                d.given.push(GivenInput {
                    path: path.to_string(),
                    read_only: false,
                });
                app.dialog = Some(Dialog::GetLaptop(*d));
            }
            BroadThen::OnTheGo(mut c) => {
                if let ConsKind::Give {
                    path: p,
                    confirmed_broad,
                    ..
                } = &mut c.kind
                {
                    *p = path.to_string();
                    *confirmed_broad = true;
                }
                app.dialog = Some(Dialog::Consequences(*c));
            }
            BroadThen::Locate(folder) => locate(app, folder, path.to_string(), true),
        }
        return false;
    }
    if other {
        restore(app);
        let purpose = match then {
            BroadThen::AddFolder => PickFor::AddFolder,
            BroadThen::Draft(_) => PickFor::Draft,
            BroadThen::OnTheGo(_) => PickFor::OnTheGo,
            BroadThen::Locate(f) => PickFor::Locate(f.clone()),
        };
        app.pick_folder(purpose);
        return false;
    }
    if closed {
        restore(app);
        return false;
    }
    true
}

fn sleep(app: &mut App, ctx: &egui::Context, snap: &Snapshot, laptop: &str) -> bool {
    let Some(lv) = snap.laptop(laptop) else {
        return false;
    };
    let mut go = false;
    let mut cancel = false;
    let (_, closed) = modal(
        ctx,
        "sleep",
        480.0,
        title(format!("Put \"{}\" to sleep?", lv.laptop.name)),
        |ui| {
            ui.label("Someone is still using this laptop in Claude Desktop.");
            ui.add_space(6.0);
            theme::warning_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(
                    RichText::new(format!(
                        "⚠ {}; the agent stops mid-task.",
                        disconnects(lv.sessions)
                    ))
                    .color(theme::AMBER_TEXT),
                );
                ui.label(
                    RichText::new("⚠ Programs the agent left running (servers, builds) stop.")
                        .color(theme::AMBER_TEXT),
                );
            });
            ui.add_space(6.0);
            ui.label(
                RichText::new("✓ Files and what the agent installed stay. Wake it up any time.")
                    .color(theme::GREEN_TEXT),
            );
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                ui.label(theme::small(
                    "With no session attached, Sleep acts at once.",
                ));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if crate::laptop::sleep_button(ui, "Sleep now", 14.0).clicked() {
                        go = true;
                    }
                    if theme::secondary(ui, "Cancel").clicked() {
                        cancel = true;
                    }
                });
            });
        },
    );
    if go {
        app.run(Command::Sleep {
            laptop: laptop.to_string(),
        });
        return false;
    }
    !(closed || cancel)
}

fn session_words(lv: &agentbook_engine::LaptopView) -> String {
    match lv.run {
        RunState::Working if lv.sessions > 0 => format!(
            "Working, {} will disconnect",
            plural(lv.sessions as usize, "session", "sessions")
        ),
        RunState::Working => "Working".to_string(),
        RunState::Sleeping => "Sleeping".to_string(),
        _ => "Not started".to_string(),
    }
}

fn remove_laptop(app: &mut App, ctx: &egui::Context, snap: &Snapshot, laptop: &str) -> bool {
    let Some(lv) = snap.laptop(laptop) else {
        return false;
    };
    let folder_path = snap
        .folder(&lv.laptop.folder_id)
        .map(|f| f.folder.path.clone())
        .unwrap_or_default();
    let mut go = false;
    let mut cancel = false;
    let (_, closed) = modal(
        ctx,
        "remove-laptop",
        500.0,
        title(format!("Remove \"{}\"?", lv.laptop.name)),
        |ui| {
            ui.label(
                "This deletes the laptop and everything the agent installed on it, and forgets \
                 its name, given folders and its own variables.",
            );
            if lv.run == RunState::Working && lv.sessions > 0 {
                ui.add_space(6.0);
                ui.label(
                    RichText::new(format!("⚠ {}.", disconnects(lv.sessions)))
                        .color(theme::AMBER_TEXT),
                );
            }
            ui.add_space(6.0);
            ui.label(
                RichText::new(format!(
                    "✓ The shared folder {folder_path} and any given folders stay on your \
                     computer untouched."
                ))
                .color(theme::GREEN_TEXT),
            );
            ui.add_space(12.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::danger(ui, "Remove laptop").clicked() {
                    go = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        },
    );
    if go {
        app.run(Command::RemoveLaptop {
            laptop: laptop.to_string(),
        });
        return false;
    }
    !(closed || cancel)
}

fn remove_folder(app: &mut App, ctx: &egui::Context, snap: &Snapshot, folder: &str) -> bool {
    let Some(fv) = snap.folder(folder) else {
        return false;
    };
    let laptops = App::laptops_of(snap, folder);
    let mut go = false;
    let mut cancel = false;
    let (_, closed) = modal(
        ctx,
        "remove-folder",
        520.0,
        title(format!(
            "Remove \"{}\" from AgentBook?",
            folder_name(&fv.folder)
        )),
        |ui| {
            if laptops.is_empty() {
                ui.label("It has no laptops.");
            } else {
                ui.label(format!(
                    "{} removed with everything the agent installed on {}:",
                    if laptops.len() == 1 {
                        "Its laptop is".to_string()
                    } else {
                        format!("Its {} laptops are", laptops.len())
                    },
                    if laptops.len() == 1 { "it" } else { "them" }
                ));
                for l in &laptops {
                    ui.horizontal(|ui| {
                        ui.add_space(12.0);
                        ui.label(format!("• {} — {}", l.laptop.name, session_words(l)));
                    });
                }
            }
            ui.add_space(6.0);
            ui.label(
                RichText::new(format!(
                    "✓ The folder {} and its files stay on your computer untouched.",
                    fv.folder.path
                ))
                .color(theme::GREEN_TEXT),
            );
            ui.add_space(12.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::danger(ui, "Remove folder").clicked() {
                    go = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        },
    );
    if go {
        app.run(Command::RemoveFolder {
            folder: folder.to_string(),
        });
        app.screen = Screen::Home;
        return false;
    }
    !(closed || cancel)
}

fn update(
    app: &mut App,
    ctx: &egui::Context,
    snap: &Snapshot,
    laptop: &str,
    action: &mut u64,
) -> bool {
    let name = snap
        .laptop(laptop)
        .map(|l| l.laptop.name.clone())
        .unwrap_or_default();
    let Some(a) = snap.action(*action).cloned() else {
        return false;
    };
    let project = snap
        .laptop(laptop)
        .and_then(|l| snap.folder(&l.laptop.folder_id))
        .is_some_and(|f| f.folder.equipment.kind == EquipmentKind::Project);
    let mut retry = false;
    let mut close = false;
    let (_, closed) = modal(
        ctx,
        "update",
        600.0,
        title(format!("Update \"{name}\"")),
        |ui| match &a.state {
            ActionState::Running => {
                ui.horizontal(|ui| {
                    ui.spinner();
                    let step = if a.steps_total > 0 {
                        format!("Step {} of {} · {}", a.step_index, a.steps_total, a.step)
                    } else {
                        "Starting…".to_string()
                    };
                    ui.label(step);
                });
                ui.label(theme::small(format!(
                    "\"{name}\" keeps working until the new Equipment is ready."
                )));
                theme::log_box(ui, &a.log_tail, 8);
            }
            ActionState::Done => {
                ui.label(
                    RichText::new(format!("✓ \"{name}\" now has the new Equipment."))
                        .color(theme::GREEN_TEXT),
                );
                ui.add_space(8.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if theme::primary(ui, "Close").clicked() {
                        close = true;
                    }
                });
            }
            ActionState::Failed { message } => {
                ui.label(
                    RichText::new(format!("✕ {} Nothing was changed.", theme::short(message)))
                        .color(theme::RED)
                        .strong(),
                );
                ui.label(
                    RichText::new(format!(
                        "✓ \"{name}\" keeps its current Equipment and keeps working. Sessions \
                         were not touched."
                    ))
                    .color(theme::GREEN_TEXT),
                );
                ui.add_space(6.0);
                theme::log_box(ui, &a.log_tail, 6);
                ui.horizontal(|ui| {
                    if project {
                        ui.label(theme::small(
                            "Fix .devcontainer in the shared folder, then Retry.",
                        ));
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if theme::link(ui, "Copy log").clicked() {
                            app.copy_log(&a);
                        }
                        if a.log_file.is_some() && theme::link(ui, "Show full log").clicked() {
                            app.show_log(&a);
                        }
                    });
                });
                ui.add_space(8.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if theme::primary(ui, "↻ Retry").clicked() {
                        retry = true;
                    }
                    if theme::secondary(ui, "Close").clicked() {
                        close = true;
                    }
                });
            }
        },
    );
    if retry
        && let Some(id) = app.run(Command::UpdateLaptop {
            laptop: laptop.to_string(),
        })
    {
        *action = id;
    }
    if matches!(a.state, ActionState::Failed { .. }) && (close || closed) {
        // The card does not repeat a failure the user has seen here.
        app.dismissed.insert(a.id);
    }
    !(close || (closed && a.finished()))
}

fn claude_dir(
    app: &mut App,
    ctx: &egui::Context,
    snap: &Snapshot,
    folder: &str,
    choice: &mut String,
) -> bool {
    let Some(fv) = snap.folder(folder) else {
        return false;
    };
    if fv.claude_choices.is_empty() {
        return false;
    }
    let fname = folder_name(&fv.folder);
    let mut go = false;
    let mut cancel = false;
    let (_, closed) = modal(
        ctx,
        "claude-dir",
        480.0,
        title("Where should the agent start?"),
        |ui| {
            ui.label(theme::muted(
                "This folder has more than one project setup (.claude/).",
            ));
            ui.label(theme::muted(
                "Pick one. AgentBook remembers it for this folder.",
            ));
            ui.add_space(8.0);
            let mut choices = fv.claude_choices.clone();
            if !choices.iter().any(String::is_empty) {
                choices.push(String::new());
            }
            for c in &choices {
                theme::card(
                    if choice == c {
                        theme::ACCENT_SOFT
                    } else {
                        egui::Color32::WHITE
                    },
                    if choice == c {
                        theme::ACCENT
                    } else {
                        theme::BORDER
                    },
                )
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    let label = if c.is_empty() {
                        "Folder root (no project setup)".to_string()
                    } else {
                        host_basename(c)
                    };
                    ui.radio_value(choice, c.clone(), theme::strong(label, 14.0));
                    if !c.is_empty() {
                        ui.label(theme::small(format!(
                            "{fname}\\{}\\.claude",
                            c.replace('/', "\\")
                        )));
                    }
                });
                ui.add_space(4.0);
            }
            ui.add_space(10.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::primary(ui, "Continue").clicked() {
                    go = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        },
    );
    if go {
        app.run(Command::ChooseClaudeDir {
            folder: folder.to_string(),
            dir: choice.clone(),
        });
        return false;
    }
    !(closed || cancel)
}

fn rename(
    app: &mut App,
    ctx: &egui::Context,
    snap: &Snapshot,
    laptop: &str,
    name: &mut String,
) -> bool {
    let Some(lv) = snap.laptop(laptop) else {
        return false;
    };
    let mut go = false;
    let mut cancel = false;
    let (_, closed) = modal(
        ctx,
        "rename",
        420.0,
        title(format!("Rename \"{}\"", lv.laptop.name)),
        |ui| {
            let r = ui.add(
                egui::TextEdit::singleline(name)
                    .desired_width(f32::INFINITY)
                    .char_limit(80),
            );
            if !r.has_focus() && !r.lost_focus() && ui.memory(|m| m.focused().is_none()) {
                r.request_focus();
            }
            if r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                go = true;
            }
            ui.label(theme::small(
                "The name is only for you. The laptop keeps its id, so Claude does not ask about \
                 trust again.",
            ));
            ui.add_space(10.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::primary(ui, "Rename").clicked() {
                    go = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        },
    );
    if go && !name.trim().is_empty() {
        app.run(Command::Rename {
            laptop: laptop.to_string(),
            name: name.trim().to_string(),
        });
        return false;
    }
    !(closed || cancel)
}

/// "1 Claude Desktop session disconnects" / "2 Claude Desktop sessions disconnect".
fn disconnects(sessions: u32) -> String {
    if sessions == 1 {
        "1 Claude Desktop session disconnects".to_string()
    } else {
        format!("{sessions} Claude Desktop sessions disconnect")
    }
}

/// "Ports…": the laptop's forwarded ports as text rows (port in the laptop, port here).
#[derive(Debug, Clone)]
pub struct PortsDraft {
    pub laptop: String,
    pub rows: Vec<(String, String)>,
    /// "Use the devcontainer's" was pressed: saving clears the laptop's own list.
    pub defaults: bool,
    pub error: Option<String>,
}

/// The rows as forwards: an empty "on this computer" means the same port. The plain message
/// names the first row that is not a port.
fn parse_ports(
    rows: &[(String, String)],
) -> Result<Vec<agentbook_core::state::PortForward>, String> {
    let mut out = Vec::new();
    for (port, host) in rows {
        let (port, host) = (port.trim(), host.trim());
        if port.is_empty() && host.is_empty() {
            continue;
        }
        let p: u16 = port
            .parse()
            .map_err(|_| format!("\"{port}\" is not a port (1 to 65535)."))?;
        let h: u16 = if host.is_empty() {
            p
        } else {
            host.parse()
                .map_err(|_| format!("\"{host}\" is not a port (1 to 65535)."))?
        };
        out.push(agentbook_core::state::PortForward::new(p, h));
    }
    agentbook_core::ports::check(&out)?;
    Ok(out)
}

fn ports(app: &mut App, ctx: &egui::Context, snap: &Snapshot, d: &mut PortsDraft) -> bool {
    let Some(lv) = snap.laptop(&d.laptop) else {
        return false;
    };
    let defaults: Vec<u16> = snap
        .folder(&lv.laptop.folder_id)
        .map(|f| f.equipment.forward_ports.clone())
        .unwrap_or_default();
    let mut save = false;
    let mut cancel = false;
    let (_, closed) = modal(
        ctx,
        "ports",
        480.0,
        title(format!("Ports of \"{}\"", lv.laptop.name)),
        |ui| {
            ui.label(theme::small(
                "A server the agent starts in the laptop (a dev server, an API) opens in your \
                 browser at localhost:<port on this computer>. AgentBook forwards these while the \
                 laptop works and AgentBook is open. The server may listen on localhost.",
            ));
            ui.add_space(8.0);
            egui::Grid::new("ports-grid")
                .num_columns(3)
                .spacing([10.0, 6.0])
                .show(ui, |ui| {
                    ui.label(theme::caption("In the laptop"));
                    ui.label(theme::caption("On this computer"));
                    ui.label("");
                    ui.end_row();
                    let mut remove = None;
                    for (i, (port, host)) in d.rows.iter_mut().enumerate() {
                        let a = ui.add(
                            egui::TextEdit::singleline(port)
                                .desired_width(110.0)
                                .hint_text("5173"),
                        );
                        let b = ui.add(
                            egui::TextEdit::singleline(host)
                                .desired_width(110.0)
                                .hint_text("same"),
                        );
                        if a.changed() || b.changed() {
                            d.defaults = false;
                            d.error = None;
                        }
                        if ui
                            .small_button("✕")
                            .on_hover_text("Stop forwarding")
                            .clicked()
                        {
                            remove = Some(i);
                        }
                        ui.end_row();
                    }
                    if let Some(i) = remove {
                        d.rows.remove(i);
                        d.defaults = false;
                    }
                });
            if theme::link(ui, "+ Add a port").clicked() {
                d.rows.push((String::new(), String::new()));
                d.defaults = false;
            }
            if !defaults.is_empty() {
                ui.add_space(6.0);
                ui.horizontal_wrapped(|ui| {
                    let list: Vec<String> = defaults.iter().map(u16::to_string).collect();
                    ui.label(theme::small(format!(
                        "The devcontainer forwards: {}.",
                        list.join(", ")
                    )));
                    if theme::link(ui, "Use these").clicked() {
                        d.rows = defaults
                            .iter()
                            .map(|p| (p.to_string(), p.to_string()))
                            .collect();
                        d.defaults = true;
                        d.error = None;
                    }
                });
            }
            if let Some(e) = &d.error {
                ui.add_space(6.0);
                ui.label(RichText::new(e).color(theme::RED));
            }
            ui.add_space(10.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::primary(ui, "Save").clicked() {
                    save = true;
                }
                if theme::secondary(ui, "Cancel").clicked() {
                    cancel = true;
                }
            });
        },
    );
    if save {
        if d.defaults {
            app.run(Command::SetPorts {
                laptop: d.laptop.clone(),
                ports: None,
            });
            return false;
        }
        match parse_ports(&d.rows) {
            Ok(list) => {
                app.run(Command::SetPorts {
                    laptop: d.laptop.clone(),
                    ports: Some(list),
                });
                return false;
            }
            Err(e) => d.error = Some(e),
        }
    }
    !(closed || cancel)
}
