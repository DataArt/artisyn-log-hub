//! The home screen (FR-1a): every shared folder the user added — with laptops, with none yet, or
//! missing on disk — each with its laptops as tiles, plus "Add a shared folder…" and drag-and-drop.

use agentbook_engine::{FolderView, RunState, Snapshot};
use egui::{Align, Layout, RichText, Ui};

use crate::app::{App, Screen, equipment_words, folder_name, plural};
use crate::dialogs::Dialog;
use crate::icons::{self, Face};
use crate::{choose, laptop, theme};

pub fn home(app: &mut App, ui: &mut Ui, snap: &Snapshot) {
    if snap.folders.is_empty() {
        choose::choose(app, ui, snap);
        return;
    }
    let working = snap
        .laptops
        .iter()
        .filter(|l| l.run == RunState::Working)
        .count();
    let sleeping = snap
        .laptops
        .iter()
        .filter(|l| l.run == RunState::Sleeping)
        .count();
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.label(theme::strong("Your shared folders", 20.0));
            ui.horizontal(|ui| {
                theme::dot(ui, theme::GREEN);
                ui.label(
                    RichText::new(format!("{} working", plural(working, "laptop", "laptops")))
                        .color(theme::TEXT_2),
                );
                theme::dot(ui, theme::FAINT);
                ui.label(RichText::new(format!("{sleeping} sleeping")).color(theme::TEXT_2));
                ui.label(theme::muted(format!(
                    "·  {}",
                    plural(snap.folders.len(), "folder", "folders")
                )));
            });
        });
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if theme::primary(ui, "📁 + Add a shared folder…").clicked() {
                app.screen = Screen::Choose;
            }
        });
    });
    ui.add_space(12.0);
    for fv in &snap.folders {
        folder_card(app, ui, snap, fv);
        ui.add_space(12.0);
    }
    drop_zone(
        app,
        ui,
        "Drop a folder here to give it laptops · or ",
        "Add a shared folder…",
    );
}

/// The dashed drop target; highlighted while a folder is dragged over the window.
pub fn drop_zone(app: &mut App, ui: &mut Ui, text: &str, link: &str) {
    let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
    let (fill, stroke) = if hovering {
        (theme::ACCENT_SOFT, theme::ACCENT)
    } else {
        (theme::SOFT, theme::BORDER_STRONG)
    };
    theme::note(fill, stroke).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.set_min_height(44.0);
        ui.horizontal_centered(|ui| {
            ui.add_space((ui.available_width() / 2.0 - 220.0).max(0.0));
            ui.label(theme::muted(text));
            if theme::link(ui, link).clicked() {
                app.screen = Screen::Choose;
            }
        });
    });
}

fn folder_menu(app: &mut App, ui: &mut Ui, fv: &FolderView) {
    ui.menu_button("⋯", |ui| {
        if ui.button("🔑 Variables…").clicked() {
            app.dialog = Some(Dialog::variables(app, &fv.folder.id));
        }
        if ui.button("Locate folder…").clicked() {
            app.pick_folder(crate::app::PickFor::Locate(fv.folder.id.clone()));
        }
        ui.separator();
        if ui
            .button(RichText::new("✕ Remove folder…").color(theme::RED))
            .clicked()
        {
            app.dialog = Some(Dialog::RemoveFolder {
                folder: fv.folder.id.clone(),
            });
        }
    });
}

fn get_laptop(app: &mut App, fv: &FolderView) {
    app.dialog = Dialog::get_laptop(app, &fv.folder.id);
}

fn folder_card(app: &mut App, ui: &mut Ui, snap: &Snapshot, fv: &FolderView) {
    let laptops = App::laptops_of(snap, &fv.folder.id);
    let name = folder_name(&fv.folder);
    let border = if fv.missing {
        theme::RED_BORDER
    } else {
        theme::BORDER
    };
    let fill = if fv.missing {
        theme::RED_SOFT
    } else {
        egui::Color32::WHITE
    };
    theme::card(fill, border).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                let title = if fv.missing {
                    format!("⚠ 📁 {name}")
                } else {
                    format!("⇄ 📁 {name}")
                };
                ui.label(theme::strong(title, 16.0));
                let mut sub = vec![fv.folder.path.clone()];
                if fv.missing {
                    sub.push(
                        "folder not found (moved, renamed or the drive is not connected)"
                            .to_string(),
                    );
                    let asleep = laptops
                        .iter()
                        .filter(|l| l.run != RunState::Working)
                        .count();
                    if !laptops.is_empty() {
                        sub.push(format!("{} sleeping", plural(asleep, "laptop", "laptops")));
                    }
                } else {
                    sub.push(format!("Equipment: {}", equipment_words(&fv.folder)));
                    if laptops.is_empty() {
                        sub.push("no laptops yet".to_string());
                    } else if !fv.repos.is_empty() {
                        sub.push(plural(fv.repos.len(), "repo", "repos"));
                    }
                }
                ui.label(theme::small(sub.join("  ·  ")));
            });
            ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                if fv.missing {
                    if theme::secondary(ui, "Remove folder…").clicked() {
                        app.dialog = Some(Dialog::RemoveFolder {
                            folder: fv.folder.id.clone(),
                        });
                    }
                    if laptops.len() == 1 && theme::secondary(ui, "Remove laptop…").clicked() {
                        app.dialog = Some(Dialog::RemoveLaptop {
                            laptop: laptops[0].laptop.id.clone(),
                        });
                    }
                    if theme::primary(ui, "Locate folder…").clicked() {
                        app.pick_folder(crate::app::PickFor::Locate(fv.folder.id.clone()));
                    }
                    return;
                }
                if !laptops.is_empty() {
                    folder_menu(app, ui, fv);
                }
                let label = if laptops.is_empty() {
                    "      + Get a laptop"
                } else {
                    "      + Laptop"
                };
                let r = theme::secondary(ui, label);
                let h = icons::BUTTON * 48.0 / 72.0;
                icons::paint(
                    ui.painter(),
                    egui::Rect::from_min_size(
                        egui::pos2(r.rect.left() + 8.0, r.rect.center().y - h / 2.0),
                        egui::vec2(icons::BUTTON, h),
                    ),
                    Face::Working,
                );
                if r.clicked() {
                    get_laptop(app, fv);
                }
                if theme::secondary(ui, "Open folder ›").clicked() {
                    app.screen = Screen::Folder(fv.folder.id.clone());
                }
            });
        });
        ui.add_space(8.0);
        if fv.missing {
            for l in &laptops {
                ui.horizontal(|ui| {
                    ui.label(theme::small(format!(
                        "{} — its laptop keeps what the agent installed. Point it at the new \
                         location, or remove the laptop.",
                        l.laptop.name
                    )));
                    if laptops.len() > 1 && theme::link(ui, "Remove laptop…").clicked() {
                        app.dialog = Some(Dialog::RemoveLaptop {
                            laptop: l.laptop.id.clone(),
                        });
                    }
                });
            }
            return;
        }
        if laptops.is_empty() {
            ui.horizontal(|ui| {
                ui.label(theme::small(
                    "The folder stays here until you remove it, so you can get a fresh laptop \
                     any time.",
                ));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if theme::link(ui, "✕ Remove folder…").clicked() {
                        app.dialog = Some(Dialog::RemoveFolder {
                            folder: fv.folder.id.clone(),
                        });
                    }
                });
            });
            return;
        }
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = egui::vec2(12.0, 12.0);
            for lv in &laptops {
                laptop::tile(app, ui, snap, fv, lv);
            }
            // The dashed "Get a laptop" tile.
            let (rect, r) = ui.allocate_exact_size(egui::vec2(306.0, 84.0), egui::Sense::click());
            let stroke_col = if r.hovered() {
                theme::ACCENT
            } else {
                theme::BORDER_STRONG
            };
            dashed_rect(ui.painter(), rect, stroke_col);
            let h = icons::BUTTON * 48.0 / 72.0;
            icons::paint(
                ui.painter(),
                egui::Rect::from_min_size(
                    egui::pos2(rect.center().x - 70.0, rect.center().y - 14.0 - h / 2.0),
                    egui::vec2(icons::BUTTON, h),
                ),
                Face::Working,
            );
            ui.painter().text(
                egui::pos2(rect.center().x - 44.0, rect.center().y - 14.0),
                egui::Align2::LEFT_CENTER,
                "+ Get a laptop",
                egui::FontId::proportional(14.0),
                theme::MUTED,
            );
            ui.painter().text(
                egui::pos2(rect.center().x, rect.center().y + 12.0),
                egui::Align2::CENTER_CENTER,
                "one click, opens Claude Desktop",
                egui::FontId::proportional(12.0),
                theme::FAINT,
            );
            if r.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                get_laptop(app, fv);
            }
        });
    });
}

/// A dashed rounded-ish rectangle (the "Get a laptop" tile).
pub fn dashed_rect(painter: &egui::Painter, rect: egui::Rect, color: egui::Color32) {
    let stroke = egui::Stroke::new(1.0, color);
    let pts = [
        rect.left_top(),
        rect.right_top(),
        rect.right_bottom(),
        rect.left_bottom(),
        rect.left_top(),
    ];
    for w in pts.windows(2) {
        painter.extend(egui::Shape::dashed_line(&[w[0], w[1]], stroke, 5.0, 4.0));
    }
}
