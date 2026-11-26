//! The folder view: the shared folder (path, where the agent starts, Equipment, Variables), its
//! laptop cards, and the "Good to know" notes on where the laptop metaphor misleads.

use agentbook_engine::{Command, FolderView, Snapshot};
use egui::{Align, Layout, RichText, Ui};

use crate::app::{App, equipment_words, folder_name};
use crate::dialogs::Dialog;
use crate::{laptop, theme};

pub fn folder(app: &mut App, ui: &mut Ui, snap: &Snapshot, id: &str) {
    let Some(fv) = snap.folder(id) else {
        return;
    };
    header(app, ui, fv);
    ui.add_space(14.0);
    let laptops = App::laptops_of(snap, id);
    ui.horizontal(|ui| {
        ui.label(theme::caption(format!("Laptops ({})", laptops.len())));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if !fv.missing && theme::primary(ui, "+ Get a laptop").clicked() {
                app.dialog = Dialog::get_laptop(app, id);
            }
        });
    });
    ui.add_space(6.0);
    if laptops.is_empty() {
        theme::note(theme::SOFT, theme::BORDER).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(theme::muted(
                "No laptops yet. \"Get a laptop\" creates one and opens Claude Desktop on it.",
            ));
        });
    }
    let width = ui.available_width();
    let columns = if width > 860.0 { 2 } else { 1 };
    for row in laptops.chunks(columns) {
        ui.columns(columns, |cols| {
            for (i, lv) in row.iter().enumerate() {
                laptop::card(app, &mut cols[i], snap, fv, lv);
            }
        });
        ui.add_space(12.0);
    }
    ui.add_space(6.0);
    theme::note(theme::SOFT, theme::BORDER).show(ui, |ui| {
        ui.set_width(ui.available_width() - 4.0);
        ui.label(theme::strong("ⓘ Good to know", 14.0));
        ui.label(
            "Changes in shared and given folders appear on your computer at once. Commit and \
             push from your computer as usual.",
        );
        ui.label(
            "Laptops with the same shared folder work on the same files. Don't give two \
             laptops the same job.",
        );
    });
}

fn header(app: &mut App, ui: &mut Ui, fv: &FolderView) {
    let name = folder_name(&fv.folder);
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.label(theme::strong(format!("⇄ 📁 Shared folder: {name}"), 18.0));
            ui.label(theme::small(format!(
                "{}  ·  you and the agent both see it, changes are instant",
                fv.folder.path
            )));
            let starts = match fv.folder.claude_dir.as_deref() {
                Some(d) if !d.is_empty() => {
                    format!("{name}/{} (has .claude/)", d.replace('\\', "/"))
                }
                _ => name.clone(),
            };
            let mut equipment = format!("Equipment: {}", equipment_words(&fv.folder));
            if let Some(c) = &fv.folder.equipment.config {
                equipment.push_str(&format!(" ({c})"));
            }
            ui.label(theme::small(format!(
                "Agent starts in: {starts}  ·  {equipment}"
            )));
        });
        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
            if theme::secondary(ui, "Open in Explorer ↗").clicked() {
                let _ = app
                    .platform
                    .open_in_file_manager(std::path::Path::new(&fv.folder.path));
            }
            if theme::secondary(ui, "🔑 Variables…").clicked() {
                app.dialog = Some(Dialog::variables(app, &fv.folder.id));
            }
        });
    });
    if fv.missing {
        theme::error_box().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(
                RichText::new(
                    "⚠ The folder was not found (moved, renamed or the drive is not connected). \
                     Its laptops keep what the agent installed.",
                )
                .color(theme::RED),
            );
            ui.horizontal(|ui| {
                if theme::primary(ui, "Locate folder…").clicked() {
                    app.pick_folder(crate::app::PickFor::Locate(fv.folder.id.clone()));
                }
                if theme::secondary(ui, "Remove folder…").clicked() {
                    app.dialog = Some(Dialog::RemoveFolder {
                        folder: fv.folder.id.clone(),
                    });
                }
            });
        });
    }
    if let Some(e) = &fv.equipment.error {
        ui.label(
            RichText::new(format!("⚠ {e}"))
                .size(12.5)
                .color(theme::AMBER_TEXT),
        );
    }
    // Several devcontainer configs: the folder's choice (FR-7).
    if !fv.config_choices.is_empty() {
        ui.horizontal(|ui| {
            ui.label(theme::small(if fv.config_choices.len() > 1 {
                "This folder has several devcontainer setups. Use:"
            } else {
                "This folder has a devcontainer setup. Use:"
            }));
            let current = fv.folder.equipment.config.clone();
            let shown = current
                .clone()
                .unwrap_or_else(|| "standard Equipment".to_string());
            egui::ComboBox::from_id_salt(("config", &fv.folder.id))
                .selected_text(shown)
                .show_ui(ui, |ui| {
                    for c in &fv.config_choices {
                        if ui
                            .selectable_label(current.as_deref() == Some(c), c)
                            .clicked()
                            && current.as_deref() != Some(c)
                        {
                            app.run(Command::ChooseEquipment {
                                folder: fv.folder.id.clone(),
                                config: Some(c.clone()),
                            });
                        }
                    }
                    if ui
                        .selectable_label(current.is_none(), "standard Equipment")
                        .clicked()
                        && current.is_some()
                    {
                        app.run(Command::ChooseEquipment {
                            folder: fv.folder.id.clone(),
                            config: None,
                        });
                    }
                });
            ui.label(theme::small(
                "New laptops use it; existing ones show \"Equipment changed\".",
            ));
        });
    }
}
