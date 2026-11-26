//! The two screens before the first laptop: the prerequisite check (FR-9, FR-10: Docker engine
//! and, on Windows, OpenSSH 9.4+) and the first-launch download (FR-10, AC-17: name, version,
//! size and progress of each item, Retry on failure).

use agentbook_engine::{
    ActionState, Command, Dependency, DependencyId, DependencyState, DockerStatus, OpensshStatus,
    Snapshot,
};
use egui::{RichText, Ui};

use crate::app::App;
use crate::theme;

pub fn prerequisites_failed(snap: &Snapshot) -> bool {
    matches!(snap.docker, DockerStatus::Failed { .. })
        || matches!(snap.openssh, OpensshStatus::Failed(_))
}

fn mark(ui: &mut Ui, ok: Option<bool>) {
    let (text, color) = match ok {
        Some(true) => ("✓", theme::GREEN_TEXT),
        Some(false) => ("✕", theme::RED),
        None => ("…", theme::MUTED),
    };
    ui.label(RichText::new(text).size(18.0).color(color).strong());
}

pub fn prerequisites(app: &mut App, ui: &mut Ui, snap: &Snapshot) {
    ui.vertical(|ui| {
        ui.set_max_width(820.0);
        ui.add_space(8.0);
        ui.label(theme::strong(
            "A few things are needed before the first laptop",
            20.0,
        ));
        ui.label(theme::muted(
            "AgentBook checked your computer. Fix the items below, then check again.",
        ));
        ui.add_space(14.0);
        theme::card(egui::Color32::WHITE, theme::BORDER).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_top(|ui| match &snap.docker {
                DockerStatus::Ok(info) => {
                    mark(ui, Some(true));
                    ui.vertical(|ui| {
                        ui.label(theme::strong(crate::app::docker_words(info), 14.0));
                        ui.label(theme::small("OK"));
                    });
                }
                DockerStatus::Failed { message, probed } => {
                    mark(ui, Some(false));
                    ui.vertical(|ui| {
                        ui.label(theme::strong("Docker engine", 14.0));
                        ui.label(message);
                        if !probed.is_empty() {
                            ui.label(theme::small(format!("Checked: {}", probed.join(", "))));
                        }
                    });
                }
                DockerStatus::Unknown => {
                    mark(ui, None);
                    ui.label(theme::strong("Docker engine — checking…", 14.0));
                }
            });
            ui.separator();
            ui.horizontal_top(|ui| match &snap.openssh {
                OpensshStatus::Ok(raw) => {
                    mark(ui, Some(true));
                    let v = agentbook_core::openssh::parse_version(raw)
                        .map(|(a, b)| format!("OpenSSH {a}.{b}"))
                        .unwrap_or_else(|| "OpenSSH".to_string());
                    ui.label(theme::strong(v, 14.0));
                    ui.label(theme::small("OK (9.4 or later)"));
                }
                OpensshStatus::Failed(message) => {
                    mark(ui, Some(false));
                    ui.vertical(|ui| {
                        ui.label(theme::strong("OpenSSH", 14.0));
                        ui.label(message);
                    });
                }
                OpensshStatus::Unknown => {
                    mark(ui, None);
                    ui.label(theme::strong("OpenSSH — checking…", 14.0));
                }
            });
        });
        ui.add_space(14.0);
        let checking = snap
            .actions
            .iter()
            .any(|a| a.kind == "prerequisites" && !a.finished());
        ui.horizontal(|ui| {
            let r = ui
                .add_enabled_ui(!checking, |ui| theme::primary(ui, "↻ Check again"))
                .inner;
            if r.clicked() {
                app.run(Command::CheckPrerequisites);
            }
            if checking {
                ui.spinner();
            }
            if theme::link(ui, "What is this? (built-in help)").clicked() {
                app.show_help("prerequisites");
            }
        });
        ui.add_space(10.0);
        ui.label(theme::muted(
            "AgentBook never installs Docker, Claude Desktop or OpenSSH itself.",
        ));
    });
}

/// Whether the first-launch download screen shows.
pub fn show_downloads(app: &App, snap: &Snapshot) -> bool {
    !app.downloads_hidden
        && snap.dependencies_checked
        && matches!(snap.docker, DockerStatus::Ok(_))
        && snap
            .dependencies
            .iter()
            .any(|d| d.state != DependencyState::Ready)
}

fn mb(bytes: u64) -> String {
    format!("{} MB", (bytes as f64 / 1_048_576.0).round() as u64)
}

fn purpose(id: DependencyId) -> &'static str {
    match id {
        DependencyId::Node => "runs the devcontainer tool",
        DependencyId::DevcontainersCli => "builds a project's own Equipment (.devcontainer)",
        DependencyId::StandardEquipment => "Ubuntu LTS with git, curl, Node.js",
    }
}

fn row(ui: &mut Ui, d: &Dependency) {
    let (icon, color) = match d.state {
        DependencyState::Ready => ("✓", theme::GREEN_TEXT),
        DependencyState::Downloading => ("↓", theme::ACCENT),
        DependencyState::Failed(_) => ("✕", theme::RED),
        DependencyState::Missing => ("·", theme::MUTED),
    };
    ui.label(RichText::new(icon).size(16.0).color(color).strong());
    ui.vertical(|ui| {
        ui.set_min_width(300.0);
        ui.label(theme::strong(&d.name, 14.0));
        ui.label(theme::small(purpose(d.id)));
    });
    ui.label(&d.version);
    ui.label(mb(d.size));
    ui.vertical(|ui| {
        ui.set_width(220.0);
        match &d.state {
            DependencyState::Ready => {
                ui.add(theme::progress(1.0).desired_height(8.0));
                ui.label(theme::small("done"));
            }
            DependencyState::Downloading => {
                let f = if d.size > 0 {
                    (d.done as f32 / d.size as f32).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                ui.add(theme::progress(f).desired_height(8.0));
                let detail = if d.detail.is_empty() {
                    format!("{} %", (f * 100.0).round())
                } else {
                    format!("{} · {} %", d.detail, (f * 100.0).round())
                };
                ui.label(theme::small(detail));
            }
            DependencyState::Missing => {
                ui.add(theme::progress(0.0).desired_height(8.0));
                ui.label(theme::small("waiting"));
            }
            DependencyState::Failed(_) => {
                ui.add(theme::progress(0.0).desired_height(8.0));
                ui.label(RichText::new("failed").size(12.5).color(theme::RED));
            }
        }
    });
    ui.end_row();
}

pub fn downloads(app: &mut App, ui: &mut Ui, snap: &Snapshot) {
    let total: u64 = snap.dependencies.iter().map(|d| d.size).sum();
    let done: u64 = snap
        .dependencies
        .iter()
        .map(|d| match d.state {
            DependencyState::Ready => d.size,
            _ => d.done.min(d.size),
        })
        .sum();
    ui.vertical(|ui| {
        ui.set_max_width(860.0);
        ui.add_space(8.0);
        ui.label(theme::strong(
            "Downloading what AgentBook needs (first launch only)",
            20.0,
        ));
        ui.label(theme::muted(format!(
            "This happens once. Next time AgentBook starts right away. Total: {}.",
            mb(total)
        )));
        ui.add_space(12.0);
        theme::card(egui::Color32::WHITE, theme::BORDER).show(ui, |ui| {
            ui.set_width(ui.available_width());
            egui::Grid::new("downloads")
                .num_columns(5)
                .spacing([18.0, 12.0])
                .show(ui, |ui| {
                    ui.label("");
                    ui.label(theme::caption("What"));
                    ui.label(theme::caption("Version"));
                    ui.label(theme::caption("Size"));
                    ui.label(theme::caption("Progress"));
                    ui.end_row();
                    for d in &snap.dependencies {
                        row(ui, d);
                    }
                });
            ui.separator();
            ui.horizontal(|ui| {
                ui.label(theme::strong("Overall", 14.0));
                ui.add(
                    theme::progress(if total > 0 {
                        done as f32 / total as f32
                    } else {
                        0.0
                    })
                    .desired_width(ui.available_width() - 140.0)
                    .desired_height(8.0),
                );
                ui.label(theme::small(format!("{} of {}", mb(done), mb(total))));
            });
            ui.label(theme::small(
                "Every file is checked before use. Uses your computer's proxy settings.",
            ));
        });
        let running = snap
            .actions
            .iter()
            .any(|a| a.kind == "download" && a.state == ActionState::Running);
        let failures: Vec<(&str, &str)> = snap
            .dependencies
            .iter()
            .filter_map(|d| match &d.state {
                DependencyState::Failed(m) => Some((d.name.as_str(), m.as_str())),
                _ => None,
            })
            .collect();
        if !failures.is_empty() && !running {
            ui.add_space(12.0);
            theme::error_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                for (name, message) in &failures {
                    ui.label(
                        RichText::new(format!("✕ Could not download {name} — {message}"))
                            .color(theme::RED),
                    );
                }
                ui.label("Nothing half-downloaded is kept. Check the connection and press Retry.");
                let only_cli = failures.iter().all(|(n, _)| {
                    snap.dependencies.iter().any(|d| {
                        d.name == *n
                            && matches!(d.id, DependencyId::DevcontainersCli | DependencyId::Node)
                    })
                });
                if only_cli {
                    ui.label(theme::small(
                        "If only the devcontainer tool is missing, folders without a \
                         .devcontainer still work.",
                    ));
                }
                if theme::primary(ui, "↻ Retry").clicked() {
                    app.start_downloads();
                }
            });
        } else if !running
            && snap
                .dependencies
                .iter()
                .any(|d| d.state == DependencyState::Missing)
        {
            ui.add_space(8.0);
            if theme::primary(ui, "Download").clicked() {
                app.start_downloads();
            }
        }
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            if theme::secondary(ui, "Continue without waiting")
                .on_hover_text(
                    "Hides this screen. Downloads that are running go on; laptops that need them \
                     wait for them.",
                )
                .clicked()
            {
                app.downloads_hidden = true;
            }
            if theme::link(ui, "What is this? (built-in help)").clicked() {
                app.show_help("first-launch");
            }
        });
    });
}
