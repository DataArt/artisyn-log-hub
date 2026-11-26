//! The app state and frame: the top bar, the screens (home, folder view, choose a folder, help,
//! prerequisites, first-launch download), banners for failed actions, the footer, and the open
//! dialog. It drives only the engine API: commands out, snapshots in.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use agentbook_core::broad_folder::{Breadth, classify};
use agentbook_core::paths::host_basename;
use agentbook_core::state::{EquipmentKind, Folder};
use agentbook_engine::{
    ActionState, ActionView, Command, DependencyState, DockerStatus, Engine, LaptopView,
    OpensshStatus, RunState, Snapshot,
};
use agentbook_platform::Platform;
use egui::{Align, Color32, Layout, RichText, Ui};

use crate::dialogs::{self, Dialog};
use crate::help::Help;
use crate::{choose, fonts, home, setup, theme, window};

/// Where the main area is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    Home,
    Folder(String),
    Choose,
    Help(String),
}

/// What a folder picked in the OS dialog is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickFor {
    /// Add a shared folder (FR-1).
    AddFolder,
    /// A given folder in the open Get a laptop dialog.
    Draft,
    /// The folder of the open "Give a folder now" dialog.
    OnTheGo,
    /// "Locate folder…" of a folder.
    Locate(String),
}

struct Picker {
    purpose: PickFor,
    result: Receiver<Option<PathBuf>>,
}

/// Action kinds shown on a laptop's card.
const LAPTOP_KINDS: &[&str] = &[
    "get-laptop",
    "get-equipment",
    "update",
    "open",
    "wake-up",
    "sleep",
    "rename",
    "give-folder",
    "given-mode",
    "remove-given",
    "remove-laptop",
];

/// Action kinds that build a laptop's first Equipment.
pub const BUILD_KINDS: &[&str] = &["get-laptop", "get-equipment"];

/// What a laptop is doing, for its card.
pub enum Activity<'a> {
    Idle,
    /// Its first Equipment is being built (state A).
    Building(&'a ActionView),
    /// The first build failed; the laptop was not started (state B).
    BuildFailed(&'a ActionView),
    /// Another action runs (opening, waking up, updating, restarting).
    Busy(&'a ActionView),
    /// Another action failed.
    Failed(&'a ActionView),
}

pub struct App {
    pub platform: Arc<dyn Platform>,
    engine: Option<Engine>,
    start_error: Option<String>,
    pub screen: Screen,
    /// Where Help returns to.
    help_back: Screen,
    pub dialog: Option<Dialog>,
    picker: Option<Picker>,
    /// Actions this window started (their failures become banners or card notes).
    watched: Vec<u64>,
    /// Failures the user closed.
    pub dismissed: HashSet<u64>,
    downloads_started: bool,
    pub downloads_hidden: bool,
    /// An Add folder action whose folder opens when it is done.
    after_add: Option<u64>,
    /// `.claude/` questions already shown this run (asked once per folder).
    claude_asked: HashSet<String>,
    pub help: Help,
}

impl App {
    pub fn new(platform: Arc<dyn Platform>, engine: Result<Engine, String>) -> Self {
        let (engine, start_error) = match engine {
            Ok(e) => (Some(e), None),
            Err(m) => (None, Some(m)),
        };
        Self {
            platform,
            engine,
            start_error,
            screen: Screen::Home,
            help_back: Screen::Home,
            dialog: None,
            picker: None,
            watched: Vec::new(),
            dismissed: HashSet::new(),
            downloads_started: false,
            downloads_hidden: false,
            after_add: None,
            claude_asked: HashSet::new(),
            help: Help::load(),
        }
    }

    /// Starts an engine command and watches its action.
    pub fn run(&mut self, command: Command) -> Option<u64> {
        let id = self.engine.as_ref()?.run(command);
        self.watched.push(id);
        Some(id)
    }

    pub fn engine(&self) -> Option<&Engine> {
        self.engine.as_ref()
    }

    pub fn home_dir(&self) -> String {
        self.platform.home_dir().to_string_lossy().into_owned()
    }

    /// How broad a folder is (whole disk, home, an ancestor of home).
    pub fn breadth(&self, path: &str) -> Breadth {
        classify(path, &self.home_dir())
    }

    pub fn show_help(&mut self, page: &str) {
        if !matches!(self.screen, Screen::Help(_)) {
            self.help_back = self.screen.clone();
        }
        self.screen = Screen::Help(page.to_string());
    }

    /// Opens the OS folder picker without blocking the window.
    pub fn pick_folder(&mut self, purpose: PickFor) {
        if self.picker.is_some() {
            return;
        }
        let (tx, rx) = channel();
        let platform = self.platform.clone();
        std::thread::spawn(move || {
            let _ = tx.send(platform.pick_folder());
        });
        self.picker = Some(Picker {
            purpose,
            result: rx,
        });
    }

    pub fn picking(&self) -> bool {
        self.picker.is_some()
    }

    fn poll_picker(&mut self) {
        let Some(p) = self.picker.as_ref() else {
            return;
        };
        let Ok(result) = p.result.try_recv() else {
            return;
        };
        let purpose = p.purpose.clone();
        self.picker = None;
        let Some(path) = result else {
            return;
        };
        let path = path.to_string_lossy().into_owned();
        match purpose {
            PickFor::AddFolder => self.add_folder(&path),
            other => dialogs::picked(self, other, path),
        }
    }

    /// FR-1: add a shared folder (asking first for a whole disk, home or an ancestor).
    pub fn add_folder(&mut self, path: &str) {
        if self.breadth(path).needs_confirmation() {
            self.dialog = Some(Dialog::whole_disk(
                path.to_string(),
                dialogs::BroadThen::AddFolder,
            ));
            return;
        }
        self.add_folder_confirmed(path, false);
    }

    pub fn add_folder_confirmed(&mut self, path: &str, confirm_broad: bool) {
        self.after_add = self.run(Command::AddFolder {
            path: path.to_string(),
            config: None,
            confirm_broad,
        });
    }

    /// Opens Claude Desktop on a laptop.
    pub fn open_laptop(&mut self, laptop: &str) {
        self.run(Command::Open {
            laptop: laptop.to_string(),
        });
    }

    /// Sleep: at once when nothing is attached, else after the confirmation.
    pub fn sleep_laptop(&mut self, lv: &LaptopView) {
        if lv.sessions > 0 {
            self.dialog = Some(Dialog::Sleep {
                laptop: lv.laptop.id.clone(),
            });
        } else {
            self.run(Command::Sleep {
                laptop: lv.laptop.id.clone(),
            });
        }
    }

    pub fn copy_text(&self, text: &str) {
        let _ = self.platform.clipboard_set(text);
    }

    /// Opens a build log in the OS's viewer for `.log` files.
    pub fn show_log(&self, action: &ActionView) {
        if let Some(path) = &action.log_file
            && self.platform.open_url(&path.to_string_lossy()).is_err()
        {
            let _ = self.platform.open_in_file_manager(path);
        }
    }

    pub fn copy_log(&self, action: &ActionView) {
        let mut text = action.log_tail.join("\n");
        if let ActionState::Failed { message } = &action.state {
            text = format!("{message}\n\n{text}");
        }
        self.copy_text(&text);
    }

    /// What a laptop is doing now, from its latest action.
    pub fn activity<'a>(&self, snap: &'a Snapshot, lv: &LaptopView) -> Activity<'a> {
        let Some(a) = snap.actions.iter().rev().find(|a| {
            a.laptop.as_deref() == Some(lv.laptop.id.as_str())
                && LAPTOP_KINDS.contains(&a.kind.as_str())
        }) else {
            return Activity::Idle;
        };
        let build = BUILD_KINDS.contains(&a.kind.as_str());
        match &a.state {
            ActionState::Running if build && lv.laptop.equipment_hash.is_none() => {
                Activity::Building(a)
            }
            ActionState::Running => Activity::Busy(a),
            ActionState::Failed { .. } if self.dismissed.contains(&a.id) => Activity::Idle,
            ActionState::Failed { .. }
                if build && matches!(lv.run, RunState::NotCreated | RunState::Unknown) =>
            {
                Activity::BuildFailed(a)
            }
            ActionState::Failed { .. } => Activity::Failed(a),
            ActionState::Done => Activity::Idle,
        }
    }

    /// The laptops of a folder, in the order they were created.
    pub fn laptops_of<'a>(snap: &'a Snapshot, folder: &str) -> Vec<&'a LaptopView> {
        snap.laptops
            .iter()
            .filter(|l| l.laptop.folder_id == folder)
            .collect()
    }

    /// Handles finished actions: Add folder opens its folder.
    fn follow_actions(&mut self, snap: &Snapshot) {
        if let Some(id) = self.after_add
            && let Some(a) = snap.action(id)
            && a.finished()
        {
            self.after_add = None;
            if a.state == ActionState::Done
                && let Some(f) = &a.folder
                && snap.folder(f).is_some()
            {
                self.screen = Screen::Folder(f.clone());
            }
        }
        if let Screen::Folder(f) = &self.screen
            && snap.folder(f).is_none()
            && self.after_add.is_none()
        {
            self.screen = Screen::Home;
        }
        // The one-time `.claude/` question.
        if self.dialog.is_none()
            && let Some(f) = snap
                .folders
                .iter()
                .find(|f| !f.claude_choices.is_empty() && !self.claude_asked.contains(&f.folder.id))
        {
            self.claude_asked.insert(f.folder.id.clone());
            self.dialog = Some(Dialog::ClaudeDir {
                folder: f.folder.id.clone(),
                choice: f.claude_choices[0].clone(),
            });
        }
        // First launch: start the downloads once the engine knows what is missing.
        if !self.downloads_started
            && snap.dependencies_checked
            && matches!(snap.docker, DockerStatus::Ok(_))
            && snap
                .dependencies
                .iter()
                .any(|d| d.state == DependencyState::Missing)
        {
            self.downloads_started = true;
            self.run(Command::DownloadDependencies);
        }
    }

    fn handle_drops(&mut self, ctx: &egui::Context) {
        let dropped: Vec<PathBuf> = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .filter_map(|f| f.path.clone())
                .collect()
        });
        let Some(path) = dropped.into_iter().find(|p| p.is_dir()) else {
            return;
        };
        if self.dialog.is_some() {
            dialogs::dropped(self, path.to_string_lossy().into_owned());
        } else if matches!(self.screen, Screen::Home | Screen::Choose) {
            self.add_folder(&path.to_string_lossy());
        }
    }

    pub fn start_downloads(&mut self) {
        self.downloads_started = true;
        self.downloads_hidden = false;
        self.run(Command::DownloadDependencies);
    }

    fn top_bar(&mut self, ui: &mut Ui, snap: &Snapshot) {
        ui.horizontal(|ui| {
            ui.set_min_height(40.0);
            crate::icons::laptop(ui, crate::icons::Face::Working, crate::icons::BUTTON);
            let brand = ui.add(
                egui::Button::new(theme::strong("AgentBook", 16.0))
                    .frame(false)
                    .sense(egui::Sense::click()),
            );
            if brand.clicked() {
                self.screen = Screen::Home;
            }
            let crumb = |ui: &mut Ui, text: &str| {
                ui.label(theme::muted("›"));
                ui.label(text);
            };
            match self.screen.clone() {
                Screen::Home => crumb(ui, "All folders"),
                Screen::Folder(id) => {
                    ui.label(theme::muted("›"));
                    if ui.link("All folders").clicked() {
                        self.screen = Screen::Home;
                    }
                    let name = snap
                        .folder(&id)
                        .map(|f| folder_name(&f.folder))
                        .unwrap_or_default();
                    crumb(ui, &format!("📁 {name}"));
                }
                Screen::Choose => {
                    ui.label(theme::muted("›"));
                    if ui.link("All folders").clicked() {
                        self.screen = Screen::Home;
                    }
                    crumb(ui, "Add a shared folder");
                }
                Screen::Help(_) => crumb(ui, "Help"),
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if matches!(self.screen, Screen::Help(_)) {
                    if theme::secondary(ui, "✕ Close help").clicked() {
                        self.screen = self.help_back.clone();
                    }
                } else {
                    if ui.add(egui::Button::new("ⓘ Help").frame(false)).clicked() {
                        self.show_help("index");
                    }
                    if ui.add(egui::Button::new("About").frame(false)).clicked() {
                        self.dialog = Some(Dialog::About);
                    }
                }
            });
        });
    }
}

/// The engine as the UI names it: its version and API version only. The product (Docker
/// Desktop, Rancher Desktop, an engine inside WSL, …) is never shown.
pub(crate) fn docker_words(info: &agentbook_engine::docker::EngineInfo) -> String {
    let mut s = "Docker engine".to_string();
    if !info.version.trim().is_empty() {
        s.push(' ');
        s.push_str(info.version.trim());
    }
    if !info.api_version.trim().is_empty() {
        s.push_str(" (API ");
        s.push_str(info.api_version.trim());
        s.push(')');
    }
    s
}

impl App {
    fn footer(ui: &mut Ui, snap: &Snapshot) {
        let docker = match &snap.docker {
            DockerStatus::Ok(info) => docker_words(info),
            DockerStatus::Failed { .. } => "Docker engine: not found".to_string(),
            DockerStatus::Unknown => "Docker engine: checking…".to_string(),
        };
        let ssh = match &snap.openssh {
            OpensshStatus::Ok(raw) => agentbook_core::openssh::parse_version(raw)
                .map(|(a, b)| format!("OpenSSH {a}.{b}"))
                .unwrap_or_else(|| "OpenSSH".to_string()),
            OpensshStatus::Failed(_) => "OpenSSH: needs 9.4 or later".to_string(),
            OpensshStatus::Unknown => "OpenSSH: checking…".to_string(),
        };
        ui.horizontal(|ui| {
            ui.label(theme::small(format!("{docker}  ·  {ssh}")));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(theme::small(format!(
                    "AgentBook {}",
                    env!("CARGO_PKG_VERSION")
                )));
            });
        });
    }

    /// Failed actions that have no laptop card to show them, and the read-only state.
    fn banners(&mut self, ui: &mut Ui, snap: &Snapshot) {
        if snap.state_read_only {
            theme::warning_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(
                    RichText::new("⚠ Update AgentBook")
                        .color(theme::AMBER_TEXT)
                        .strong(),
                );
                let why = snap.state_error.clone().unwrap_or_else(|| {
                    "Your folders and laptops were saved by a newer AgentBook.".to_string()
                });
                ui.label(format!(
                    "{why} This copy shows them but saves no changes. Run the newest AgentBook."
                ));
            });
            ui.add_space(8.0);
        }
        let failed: Vec<ActionView> = self
            .watched
            .iter()
            .filter_map(|id| snap.action(*id))
            .filter(|a| matches!(a.state, ActionState::Failed { .. }))
            .filter(|a| !self.dismissed.contains(&a.id))
            .filter(|a| {
                a.kind != "download" && a.laptop.as_deref().is_none_or(|l| snap.laptop(l).is_none())
            })
            .cloned()
            .collect();
        for a in failed {
            let ActionState::Failed { message } = &a.state else {
                continue;
            };
            theme::error_box().show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(format!("✕ {}", theme::short(message))).color(theme::RED),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui.small_button("✕").on_hover_text("Close").clicked() {
                            self.dismissed.insert(a.id);
                        }
                        if !a.log_tail.is_empty() && theme::link(ui, "Copy log").clicked() {
                            self.copy_log(&a);
                        }
                    });
                });
            });
            ui.add_space(8.0);
        }
        // Folder-wide work in progress.
        for a in snap.actions.iter().filter(|a| {
            !a.finished()
                && matches!(
                    a.kind.as_str(),
                    "add-folder" | "locate-folder" | "remove-folder" | "choose-equipment"
                )
        }) {
            ui.horizontal(|ui| {
                ui.spinner();
                let what = match a.kind.as_str() {
                    "add-folder" => "Adding the folder…",
                    "locate-folder" => "Pointing the laptops at the new location…",
                    "remove-folder" => "Removing the folder from AgentBook…",
                    _ => "Changing the Equipment…",
                };
                ui.label(what);
                if !a.step.is_empty() {
                    ui.label(theme::muted(&a.step));
                }
            });
        }
        // Downloads still missing after the first-launch screen was hidden.
        if self.downloads_hidden
            && snap
                .dependencies
                .iter()
                .any(|d| d.state != DependencyState::Ready)
        {
            ui.horizontal(|ui| {
                ui.label(theme::muted(
                    "Some first-launch downloads are not finished.",
                ));
                if theme::link(ui, "Show").clicked() {
                    self.downloads_hidden = false;
                }
            });
        }
    }

    fn main_area(&mut self, ui: &mut Ui, snap: &Snapshot) {
        if let Screen::Help(page) = self.screen.clone() {
            self.help_screen(ui, &page);
            return;
        }
        if setup::prerequisites_failed(snap) {
            setup::prerequisites(self, ui, snap);
            return;
        }
        if setup::show_downloads(self, snap) {
            setup::downloads(self, ui, snap);
            return;
        }
        self.banners(ui, snap);
        match self.screen.clone() {
            Screen::Home => home::home(self, ui, snap),
            Screen::Folder(id) => match snap.folder(&id) {
                Some(_) => crate::folder::folder(self, ui, snap, &id),
                None => home::home(self, ui, snap),
            },
            Screen::Choose => choose::choose(self, ui, snap),
            Screen::Help(_) => {}
        }
    }

    fn help_screen(&mut self, ui: &mut Ui, page_id: &str) {
        let mut go = None;
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                ui.set_width(190.0);
                ui.label(theme::caption("Help"));
                ui.add_space(4.0);
                for p in &self.help.pages {
                    let selected = p.id == page_id;
                    if ui.selectable_label(selected, &p.title).clicked() {
                        go = Some(p.id.to_string());
                    }
                }
            });
            ui.separator();
            ui.vertical(|ui| {
                ui.set_max_width(720.0);
                let page = self.help.page(page_id);
                if let Some(next) = crate::help::page_ui(ui, page) {
                    go = Some(next);
                }
            });
        });
        if let Some(next) = go {
            self.screen = Screen::Help(next);
        }
    }

    fn start_error_ui(&mut self, ui: &mut Ui) {
        egui::CentralPanel::default().show(ui, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(80.0);
                crate::icons::laptop(ui, crate::icons::Face::Sleeping, 108.0);
                ui.add_space(16.0);
                let message = self.start_error.clone().unwrap_or_default();
                ui.label(theme::strong(message, 18.0));
                ui.add_space(6.0);
                ui.label(theme::muted(
                    "Switch to the AgentBook window that is already open. If there is none, \
                     wait a moment and start AgentBook again.",
                ));
                ui.add_space(16.0);
                if theme::primary(ui, "Close").clicked() {
                    ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                }
            });
        });
    }
}

impl window::Frame for App {
    fn setup(&mut self, ctx: &egui::Context) {
        if !fonts::install(ctx, self.platform.as_ref()) {
            // Nothing can be drawn without a font; the platform found none.
            eprintln!("AgentBook: no UI font found in the system font folder");
        }
        theme::apply(ctx);
    }

    fn ui(&mut self, ui: &mut Ui) {
        if self.engine.is_none() {
            self.start_error_ui(ui);
            return;
        }
        let Some(snap) = self.engine.as_ref().map(Engine::snapshot) else {
            return;
        };
        let ctx = ui.ctx().clone();
        ctx.request_repaint_after(Duration::from_millis(400));
        self.poll_picker();
        self.follow_actions(&snap);
        self.handle_drops(&ctx);

        egui::Panel::top("top")
            .frame(
                egui::Frame::new()
                    .fill(Color32::WHITE)
                    .inner_margin(egui::Margin::symmetric(20, 4))
                    .stroke(egui::Stroke::new(1.0, theme::BORDER)),
            )
            .show(ui, |ui| self.top_bar(ui, &snap));
        egui::Panel::bottom("footer")
            .frame(
                egui::Frame::new()
                    .fill(theme::SOFT)
                    .inner_margin(egui::Margin::symmetric(20, 6))
                    .stroke(egui::Stroke::new(1.0, theme::BORDER)),
            )
            .show(ui, |ui| Self::footer(ui, &snap));
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(Color32::WHITE)
                    .inner_margin(egui::Margin::symmetric(24, 16)),
            )
            .show(ui, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| self.main_area(ui, &snap));
            });
        if let Some(mut d) = self.dialog.take() {
            let keep = dialogs::show(self, &ctx, &snap, &mut d);
            if keep && self.dialog.is_none() {
                self.dialog = Some(d);
            }
        }
    }
}

/// The folder's display name (its last path component).
pub fn folder_name(f: &Folder) -> String {
    host_basename(&f.path)
}

/// "from the project (.devcontainer)" / "standard".
pub fn equipment_words(f: &Folder) -> &'static str {
    match f.equipment.kind {
        EquipmentKind::Project => "from the project",
        _ => "standard",
    }
}

/// "1 laptop", "3 laptops".
pub fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// The status words of a laptop ("Working · 2 sessions").
pub fn status_words(lv: &LaptopView) -> (String, Color32, Color32) {
    match lv.run {
        RunState::Working => {
            let mut s = "Working".to_string();
            if lv.sessions > 0 {
                s.push_str(&format!(
                    " · {}",
                    plural(lv.sessions as usize, "session", "sessions")
                ));
            }
            (s, theme::GREEN, theme::GREEN_TEXT)
        }
        RunState::Sleeping => ("Sleeping".to_string(), theme::FAINT, theme::MUTED),
        RunState::NotCreated => ("Not started".to_string(), theme::FAINT, theme::MUTED),
        RunState::Unknown => ("Looking…".to_string(), theme::FAINT, theme::MUTED),
    }
}
