//! A laptop on screen: the home-screen tile and the folder-view card, with the four Equipment
//! states (first build, failed build with Retry, Equipment changed, working), Sleep / Wake up,
//! the "needs a value" note, missing folders and the "⋯" menu.

use agentbook_core::equipment::EquipmentState;
use agentbook_core::paths::host_basename;
use agentbook_core::state::EquipmentKind;
use agentbook_engine::{
    ActionState, ActionView, Command, FolderView, LaptopView, RunState, Snapshot,
};
use egui::{Align, Layout, RichText, Ui};

use crate::app::{Activity, App, plural, status_words};
use crate::dialogs::{ConsKind, Dialog};
use crate::icons::{self, Face};
use crate::theme;

/// The face a laptop shows.
pub fn face(activity: &Activity, lv: &LaptopView) -> Face {
    match activity {
        Activity::Building(_) => Face::GettingEquipment,
        Activity::BuildFailed(_) => Face::NotStarted,
        _ => match lv.run {
            RunState::Working => Face::Working,
            RunState::NotCreated => Face::NotStarted,
            _ => Face::Sleeping,
        },
    }
}

fn busy_words(a: &ActionView) -> &'static str {
    match a.kind.as_str() {
        "open" => "Opening…",
        "wake-up" => "Waking up…",
        "sleep" => "Going to sleep…",
        "update" => "Updating…",
        "rename" => "Renaming…",
        "remove-laptop" => "Removing…",
        "get-laptop" | "get-equipment" => "Starting…",
        _ => "Restarting with the new folders…",
    }
}

fn step_words(a: &ActionView) -> String {
    if a.steps_total > 0 {
        format!("Step {} of {} · {}", a.step_index, a.steps_total, a.step)
    } else {
        a.step.clone()
    }
}

/// The "⋯" menu of a laptop.
fn menu(app: &mut App, ui: &mut Ui, lv: &LaptopView) {
    ui.menu_button("⋯", |ui| {
        let id = &lv.laptop.id;
        if ui.button("✎ Rename").clicked() {
            app.dialog = Some(Dialog::Rename {
                laptop: id.clone(),
                name: lv.laptop.name.clone(),
            });
        }
        if ui.button("📁 Give a folder now…").clicked() {
            app.dialog = Some(Dialog::consequences(
                id.clone(),
                ConsKind::Give {
                    path: String::new(),
                    read_only: false,
                    confirmed_broad: false,
                },
            ));
        }
        if ui.button("🔑 Variables…").clicked() {
            app.dialog = Some(Dialog::variables(app, &lv.laptop.folder_id));
        }
        if ui.button("⧉ Another laptop like this").clicked() {
            app.dialog = Dialog::like_this(app, id, None);
        }
        ui.separator();
        if ui
            .button(RichText::new("✕ Remove laptop…").color(theme::RED))
            .clicked()
        {
            app.dialog = Some(Dialog::RemoveLaptop { laptop: id.clone() });
        }
    });
}

/// A button with the sleeping laptop (button size) before its text.
pub fn sleep_button(ui: &mut Ui, text: &str, size: f32) -> egui::Response {
    let pad = icons::BUTTON + 4.0;
    let spaces = (pad / (size * 0.27)).ceil() as usize;
    let r = ui.add(egui::Button::new(
        RichText::new(format!("{}{text}", " ".repeat(spaces))).size(size),
    ));
    let h = icons::BUTTON * 48.0 / 72.0;
    let rect = egui::Rect::from_min_size(
        egui::pos2(r.rect.left() + 8.0, r.rect.center().y - h / 2.0),
        egui::vec2(icons::BUTTON, h),
    );
    icons::paint(ui.painter(), rect, Face::Sleeping);
    r
}

/// The Sleep or Wake up button.
fn sleep_wake(app: &mut App, ui: &mut Ui, lv: &LaptopView, busy: bool, size: f32) {
    match lv.run {
        RunState::Working => {
            let r = ui
                .add_enabled_ui(!busy, |ui| sleep_button(ui, "Sleep", size))
                .inner
                .on_hover_text("Stops the laptop. Files and what the agent installed stay.");
            if r.clicked() {
                app.sleep_laptop(lv);
            }
        }
        RunState::Sleeping => {
            let r = ui
                .add_enabled_ui(!busy, |ui| theme::wake_up(ui, size))
                .inner;
            if r.clicked() {
                app.run(Command::WakeUp {
                    laptop: lv.laptop.id.clone(),
                });
            }
        }
        _ => {}
    }
}

/// The "Open laptop ↗" button (disabled while the Equipment is built).
fn open_button(app: &mut App, ui: &mut Ui, lv: &LaptopView, building: bool, size: f32) {
    let r = ui
        .add_enabled_ui(!building, |ui| {
            theme::primary_sized(ui, "Open laptop ↗", size)
        })
        .inner;
    if r.clicked() {
        app.open_laptop(&lv.laptop.id);
    }
    if building {
        ui.label(theme::small("opens when ready"));
    }
}

/// The first build (state A).
/// "12 MB" / "1.2 GB" for a size in KB.
fn size_words(kb: u64) -> String {
    let mb = kb as f64 / 1024.0;
    if mb >= 1024.0 {
        format!("{:.1} GB", mb / 1024.0)
    } else {
        format!("{mb:.0} MB")
    }
}

/// While Claude Desktop sets up Claude on the laptop (its first connection): what is going on, and
/// that the Variables can be set meanwhile (they reach the laptop at once; `ws env` reads them).
fn claude_setup_box(app: &mut App, ui: &mut Ui, fv: &FolderView) {
    theme::note(theme::ACCENT_SOFT, theme::BORDER).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(
            RichText::new("Claude Desktop is setting up Claude on this laptop")
                .color(theme::ACCENT)
                .strong(),
        );
        ui.label(theme::small(
            "The first time it connects to a laptop, Claude Desktop copies Claude Code into it \
             (a few hundred MB). The Claude Desktop window waits until it is done; this takes a \
             minute or two.",
        ));
        ui.horizontal(|ui| {
            ui.label(theme::small(
                "Meanwhile you can set the Variables the agent will need (tokens, URLs):",
            ));
            if theme::link(ui, "🔑 Variables…").clicked() {
                app.dialog = Some(Dialog::variables(app, &fv.folder.id));
            }
        });
    });
    ui.add_space(4.0);
}

fn building_box(ui: &mut Ui, app: &App, a: &ActionView, project: bool) {
    theme::note(theme::ACCENT_SOFT, theme::BORDER).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(theme::strong(
            if project {
                "Building the project's Equipment"
            } else {
                "Getting the standard Equipment ready"
            },
            14.0,
        ));
        ui.label(theme::small("First time only — next start is quick."));
        ui.add_space(4.0);
        if !a.step.is_empty() {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(RichText::new(step_words(a)).size(12.5));
            });
        }
        if a.steps_total > 0 {
            ui.add(
                theme::progress(a.step_index.saturating_sub(1) as f32 / a.steps_total as f32)
                    .desired_height(6.0),
            );
        }
        theme::log_box(ui, &a.log_tail, 5);
        if a.log_file.is_some() && theme::link(ui, "Show full log").clicked() {
            app.show_log(a);
        }
    });
}

/// A failed first build (state B): the log tail, Copy log and Retry.
fn build_failed_box(app: &mut App, ui: &mut Ui, a: &ActionView, lv: &LaptopView, project: bool) {
    let ActionState::Failed { message } = &a.state else {
        return;
    };
    theme::error_box().show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(
            RichText::new(if project {
                "✕ The project's Equipment did not build."
            } else {
                "✕ The standard Equipment did not build."
            })
            .color(theme::RED)
            .strong(),
        );
        if !message.contains("Command failed") {
            ui.label(
                RichText::new(theme::short(message))
                    .size(12.5)
                    .color(theme::RED),
            );
        }
        ui.label("The laptop was not started. Last lines of the log:");
        theme::log_box(ui, &a.log_tail, 6);
        ui.horizontal(|ui| {
            if a.log_file.is_some() && theme::link(ui, "Show full log").clicked() {
                app.show_log(a);
            }
            if theme::link(ui, "Copy log").clicked() {
                app.copy_log(a);
            }
        });
        if project {
            ui.label(theme::small(
                "Fix .devcontainer in the shared folder, then Retry.",
            ));
        }
        if ui
            .horizontal(|ui| theme::secondary(ui, "↻ Retry"))
            .inner
            .clicked()
        {
            app.run(Command::GetEquipment {
                laptop: lv.laptop.id.clone(),
            });
        }
    });
}

fn failed_box(app: &mut App, ui: &mut Ui, a: &ActionView) {
    let ActionState::Failed { message } = &a.state else {
        return;
    };
    theme::error_box().show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new(format!("✕ {}", theme::short(message))).color(theme::RED));
        });
        ui.horizontal(|ui| {
            if !a.log_tail.is_empty() && theme::link(ui, "Copy log").clicked() {
                app.copy_log(a);
            }
            if a.log_file.is_some() && theme::link(ui, "Show full log").clicked() {
                app.show_log(a);
            }
            if theme::link(ui, "Close").clicked() {
                app.dismissed.insert(a.id);
            }
        });
    });
}

/// Notes shared by the tile and the card: Equipment changed, host exposure, variables needing a
/// value, missing folders, a duplicate name, the last action's note.
fn notes(app: &mut App, ui: &mut Ui, fv: &FolderView, lv: &LaptopView, full: bool) {
    let project = fv.folder.equipment.kind == EquipmentKind::Project;
    if lv.equipment == Some(EquipmentState::Changed) {
        theme::warning_box().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(
                RichText::new("⚠ Equipment changed — Update laptop")
                    .color(theme::AMBER_TEXT)
                    .strong(),
            );
            if full {
                ui.label(theme::small(if project {
                    ".devcontainer was edited. This laptop keeps its own; new laptops get the new."
                } else {
                    "AgentBook has new standard Equipment. This laptop keeps its own; new laptops \
                     get the new."
                }));
            }
            ui.horizontal(|ui| {
                if theme::secondary_small(ui, "Update laptop…").clicked() {
                    app.dialog = Some(Dialog::consequences(lv.laptop.id.clone(), ConsKind::Update));
                }
                ui.label(theme::small("keeps its home"));
            });
        });
    }
    if full && project && !fv.equipment.exposures.is_empty() {
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
            ui.label(theme::small(
                "Your project's choice; AgentBook does not block it.",
            ));
        });
    }
    if !lv.needs_value.is_empty() {
        theme::warning_box().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_wrapped(|ui| {
                let n = lv.needs_value.len();
                let verb = if n == 1 { "needs" } else { "need" };
                ui.label(
                    RichText::new(format!(
                        "⚠ {} {verb} a value: {}",
                        plural(n, "variable", "variables"),
                        lv.needs_value.join(", ")
                    ))
                    .size(12.5)
                    .color(theme::AMBER_TEXT),
                );
                if theme::link(ui, "Set…").clicked() {
                    app.dialog = Some(Dialog::variables(app, &lv.laptop.folder_id));
                }
            });
        });
    }
    for missing in &lv.missing_sources {
        let shared = agentbook_core::paths::strip_verbatim(missing)
            .eq_ignore_ascii_case(&agentbook_core::paths::strip_verbatim(&fv.folder.path));
        theme::error_box().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(
                RichText::new(format!(
                    "The folder {missing} is missing; the laptop cannot start."
                ))
                .color(theme::RED)
                .size(12.5),
            );
            if shared {
                if theme::link(ui, "Locate folder…").clicked() {
                    app.pick_folder(crate::app::PickFor::Locate(fv.folder.id.clone()));
                }
            } else if theme::link(ui, "Take this folder away…").clicked() {
                app.dialog = Some(Dialog::consequences(
                    lv.laptop.id.clone(),
                    ConsKind::RemoveGiven {
                        path: missing.clone(),
                    },
                ));
            }
        });
    }
    if lv.duplicate_name {
        ui.label(theme::small(
            "Another laptop of this folder has the same name.",
        ));
    }
    if let Some(note) = &lv.note {
        ui.label(theme::small(note));
    }
}

/// The repos line of a tile ("repo-a: feature/q3").
fn repos_line(fv: &FolderView) -> Option<String> {
    let r = fv.repos.first()?;
    let branch = r.branch.clone().unwrap_or_else(|| "?".to_string());
    Some(
        if fv.repos.len() == 1 && r.name == host_basename(&fv.folder.path) {
            branch
        } else {
            format!("{}: {branch}", r.name)
        },
    )
}

/// The home-screen tile (36 px icon).
pub fn tile(app: &mut App, ui: &mut Ui, snap: &Snapshot, fv: &FolderView, lv: &LaptopView) {
    let activity = app.activity(snap, lv);
    let face = face(&activity, lv);
    let working = lv.run == RunState::Working;
    let (fill, stroke) = if working {
        (egui::Color32::WHITE, theme::ACCENT)
    } else {
        (theme::SOFT, theme::BORDER)
    };
    let project = fv.folder.equipment.kind == EquipmentKind::Project;
    egui::Frame::new()
        .fill(fill)
        .stroke(egui::Stroke::new(1.0, stroke))
        .corner_radius(6)
        .inner_margin(10)
        .show(ui, |ui| {
            // The tiles sit in a wrapping row: lay the tile out top-down, at a fixed width.
            ui.vertical(|ui| {
                ui.set_width(286.0);
                ui.horizontal(|ui| {
                    icons::laptop(ui, face, icons::TILE);
                    ui.vertical(|ui| {
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::Label::new(
                                    theme::strong(&lv.laptop.name, 14.0).color(if working {
                                        theme::TEXT
                                    } else {
                                        theme::TEXT_2
                                    }),
                                )
                                .truncate(),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if theme::link(ui, "⧉ like this")
                                    .on_hover_text("Another laptop like this")
                                    .clicked()
                                {
                                    app.dialog = Dialog::like_this(app, &lv.laptop.id, None);
                                }
                            });
                        });
                        ui.horizontal(|ui| {
                            let busy = match &activity {
                                Activity::Building(a) => {
                                    theme::dot(ui, theme::ACCENT);
                                    let step = if a.steps_total > 0 {
                                        format!(" · step {} of {}", a.step_index, a.steps_total)
                                    } else {
                                        String::new()
                                    };
                                    ui.label(
                                        RichText::new(format!("Getting equipment…{step}"))
                                            .size(12.5)
                                            .color(theme::ACCENT),
                                    );
                                    true
                                }
                                Activity::BuildFailed(_) => {
                                    theme::dot(ui, theme::RED);
                                    ui.label(
                                        RichText::new("Not started").size(12.5).color(theme::RED),
                                    );
                                    false
                                }
                                Activity::Busy(a) => {
                                    ui.spinner();
                                    ui.label(theme::small(busy_words(a)));
                                    true
                                }
                                _ => {
                                    let (words, dot, color) = status_words(lv);
                                    theme::dot(ui, dot);
                                    ui.label(RichText::new(words).size(12.5).color(color));
                                    false
                                }
                            };
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if lv.run == RunState::Working {
                                    sleep_wake(app, ui, lv, busy, 12.5);
                                }
                            });
                        });
                    });
                });
                ui.horizontal(|ui| {
                    match &activity {
                        Activity::BuildFailed(_) => {
                            if theme::secondary_small(ui, "↻ Retry").clicked() {
                                app.run(Command::GetEquipment {
                                    laptop: lv.laptop.id.clone(),
                                });
                            }
                            if theme::link(ui, "Show what failed").clicked() {
                                app.screen = crate::app::Screen::Folder(fv.folder.id.clone());
                            }
                        }
                        _ => {
                            let building = matches!(activity, Activity::Building(_));
                            let busy = matches!(activity, Activity::Busy(_));
                            let r = ui
                                .add_enabled_ui(!building && !busy, |ui| {
                                    theme::primary_sized(ui, "Open laptop ↗", 12.5)
                                })
                                .inner;
                            if r.clicked() {
                                app.open_laptop(&lv.laptop.id);
                            }
                            if lv.run == RunState::Sleeping {
                                sleep_wake(app, ui, lv, busy, 12.5);
                            }
                        }
                    }
                    let extra = if lv.laptop.given.is_empty() {
                        repos_line(fv)
                    } else {
                        Some(plural(lv.laptop.given.len(), "folder", "folders"))
                    };
                    if let Some(extra) = extra {
                        ui.add(egui::Label::new(theme::small(extra)).truncate());
                    }
                });
                if let Activity::Failed(a) = &activity {
                    failed_box(app, ui, a);
                }
                let _ = project;
                notes(app, ui, fv, lv, false);
            });
        });
}

/// The folder-view card (54 px icon), with the full Equipment states.
pub fn card(app: &mut App, ui: &mut Ui, snap: &Snapshot, fv: &FolderView, lv: &LaptopView) {
    let activity = app.activity(snap, lv);
    let face = face(&activity, lv);
    let working = lv.run == RunState::Working;
    let project = fv.folder.equipment.kind == EquipmentKind::Project;
    let stroke = if working {
        theme::ACCENT
    } else {
        theme::BORDER
    };
    let fill = if working {
        egui::Color32::WHITE
    } else {
        theme::SOFT
    };
    theme::card(fill, stroke).show(ui, |ui| {
        ui.set_width(ui.available_width());
        let building = matches!(activity, Activity::Building(_));
        let busy = matches!(activity, Activity::Busy(_)) || building;
        ui.horizontal(|ui| {
            icons::laptop(ui, face, icons::CARD);
            ui.vertical(|ui| {
                ui.horizontal(|ui| {
                    ui.add(egui::Label::new(theme::strong(&lv.laptop.name, 16.0)).truncate());
                    if theme::link(ui, "✎ rename").clicked() {
                        app.dialog = Some(Dialog::Rename {
                            laptop: lv.laptop.id.clone(),
                            name: lv.laptop.name.clone(),
                        });
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        sleep_wake(app, ui, lv, busy, 13.5);
                    });
                });
                ui.horizontal(|ui| match &activity {
                    Activity::Building(_) => {
                        theme::dot(ui, theme::ACCENT);
                        ui.label(RichText::new("Getting equipment…").color(theme::ACCENT));
                    }
                    Activity::BuildFailed(_) => {
                        theme::dot(ui, theme::RED);
                        ui.label(RichText::new("Not started").color(theme::RED));
                    }
                    Activity::Busy(a) => {
                        ui.spinner();
                        ui.label(theme::muted(busy_words(a)));
                        if !a.step.is_empty() {
                            ui.label(theme::small(step_words(a)));
                        }
                    }
                    _ => {
                        let (_, dot, color) = status_words(lv);
                        theme::dot(ui, dot);
                        match lv.run {
                            RunState::Working if lv.claude_setup_kb.is_some() => {
                                ui.label(RichText::new("Working").color(color));
                                ui.spinner();
                                ui.label(theme::muted(format!(
                                    "· Claude Desktop is setting up Claude here: {} copied",
                                    size_words(lv.claude_setup_kb.unwrap_or(0))
                                )));
                            }
                            RunState::Working => {
                                ui.label(RichText::new("Working").color(color));
                                ui.label(theme::muted(if lv.sessions == 0 {
                                    "· no Claude Desktop session attached".to_string()
                                } else {
                                    format!(
                                        "· {} attached",
                                        plural(
                                            lv.sessions as usize,
                                            "Claude Desktop session",
                                            "Claude Desktop sessions"
                                        )
                                    )
                                }));
                            }
                            _ => {
                                ui.label(RichText::new(status_words(lv).0).color(color));
                            }
                        }
                    }
                });
                ui.label(theme::small(format!(
                    "Equipment: {}",
                    crate::app::equipment_words(&fv.folder)
                )));
            });
        });
        ui.add_space(4.0);
        if lv.run == RunState::Working && lv.claude_setup_kb.is_some() {
            claude_setup_box(app, ui, fv);
        }
        match &activity {
            Activity::Building(a) => building_box(ui, app, a, project),
            Activity::BuildFailed(a) => build_failed_box(app, ui, a, lv, project),
            Activity::Failed(a) => failed_box(app, ui, a),
            Activity::Idle if lv.run == RunState::NotCreated => {
                theme::error_box().show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.label(
                        RichText::new("The laptop was not started: its Equipment is not ready.")
                            .color(theme::RED),
                    );
                    if project {
                        ui.label(theme::small(
                            "Fix .devcontainer in the shared folder if the last build failed, then 
                             Retry.",
                        ));
                    }
                    if ui
                        .horizontal(|ui| theme::secondary(ui, "↻ Retry"))
                        .inner
                        .clicked()
                    {
                        app.run(Command::GetEquipment {
                            laptop: lv.laptop.id.clone(),
                        });
                    }
                });
            }
            _ => {}
        }
        notes(app, ui, fv, lv, true);
        ui.add_space(4.0);
        ui.label(theme::caption("Repos in shared folder"));
        if fv.repos.is_empty() {
            ui.label(theme::small("No git repos"));
        }
        for r in fv.repos.iter().take(6) {
            ui.label(
                RichText::new(format!(
                    "{}: {}",
                    r.name,
                    r.branch.as_deref().unwrap_or("?")
                ))
                .size(12.5),
            );
        }
        if fv.repos.len() > 6 {
            ui.label(theme::small(format!("and {} more", fv.repos.len() - 6)));
        }
        ui.add_space(4.0);
        ui.label(theme::caption("Given folders"));
        if lv.laptop.given.is_empty() {
            ui.label(theme::small("None yet"));
        }
        for g in &lv.laptop.given {
            ui.horizontal(|ui| {
                ui.add(
                    egui::Label::new(RichText::new(format!("📁 {}", g.path)).size(12.5)).truncate(),
                );
                let mode = if g.read_only {
                    "👁 View only"
                } else {
                    "✎ Can change"
                };
                ui.add_enabled_ui(!busy, |ui| {
                    egui::ComboBox::from_id_salt(("mode", &lv.laptop.id, &g.path))
                        .selected_text(RichText::new(mode).size(12.5))
                        .show_ui(ui, |ui| {
                            for (ro, text) in [(false, "✎ Can change"), (true, "👁 View only")]
                            {
                                if ui.selectable_label(g.read_only == ro, text).clicked()
                                    && g.read_only != ro
                                {
                                    app.dialog = Some(Dialog::consequences(
                                        lv.laptop.id.clone(),
                                        ConsKind::SetMode {
                                            path: g.path.clone(),
                                            read_only: ro,
                                        },
                                    ));
                                }
                            }
                        });
                    if ui
                        .small_button("✕")
                        .on_hover_text("Take this folder away")
                        .clicked()
                    {
                        app.dialog = Some(Dialog::consequences(
                            lv.laptop.id.clone(),
                            ConsKind::RemoveGiven {
                                path: g.path.clone(),
                            },
                        ));
                    }
                });
            });
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            match &activity {
                Activity::BuildFailed(_) => {}
                Activity::Idle if lv.run == RunState::NotCreated => {}
                _ => open_button(app, ui, lv, building, 14.0),
            }
            if theme::secondary(ui, "⧉ Another laptop like this").clicked() {
                app.dialog = Dialog::like_this(app, &lv.laptop.id, None);
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                menu(app, ui, lv);
            });
        });
        if lv.run == RunState::Sleeping {
            ui.label(theme::small(
                "\"Open laptop\" wakes it and opens Claude Desktop; \"Wake up\" only wakes it.",
            ));
        }
    });
}
