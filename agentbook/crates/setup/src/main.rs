//! AgentBook installer (`AgentBook-Setup.exe`): copies the embedded `AgentBook.exe` to
//! `%LOCALAPPDATA%\Programs\AgentBook\` and creates a Start-menu shortcut, with no admin rights.
//!
//! - It never touches the AgentBook data folder (`%LOCALAPPDATA%\AgentBook\`): running a newer
//!   setup over an older install replaces only the program, so folders and laptops are kept. It
//!   only probes the single-instance lock there (never creating it) to see whether AgentBook runs.
//! - While AgentBook runs (the lock is held, or the exe cannot be replaced) it asks the user to
//!   close it, with Retry / Cancel, instead of failing.
//! - The new exe is written next to the old one under a temporary name and renamed over it, so a
//!   failed copy never leaves a half-written `AgentBook.exe`.
//!
//! Options (for scripted installs and checks): `--quiet` shows no dialogs (exit code 3 when
//! AgentBook is running), `--dest <dir>` and `--start-menu <dir>` replace the two folders.

// A GUI program: no console window in release builds (debug builds keep it for messages).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use agentbook_platform::installer::{self as os, Notice};

/// `AgentBook.exe`, embedded by `npm run build` (see `build.rs`); empty in any other build.
const PAYLOAD: &[u8] = include_bytes!(env!("AGENTBOOK_SETUP_PAYLOAD"));
const VERSION: &str = env!("CARGO_PKG_VERSION");
const TITLE: &str = "AgentBook Setup";
const EXE_NAME: &str = "AgentBook.exe";
const STAGED_NAME: &str = "AgentBook.exe.new";
const SHORTCUT_NAME: &str = "AgentBook.lnk";
const SHORTCUT_DESCRIPTION: &str = "AgentBook: isolated laptops on your shared folders";
const RUNNING_MESSAGE: &str = "AgentBook is running.\n\nClose every AgentBook window, then click \
Retry.\n\nYour folders and laptops are kept: setup replaces only the program.";

const EXIT_FAILED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_CANCELLED: u8 = 3;

#[derive(Debug, Default)]
struct Options {
    quiet: bool,
    dest: Option<PathBuf>,
    start_menu: Option<PathBuf>,
}

fn parse_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<Options, String> {
    let mut opts = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--quiet") => opts.quiet = true,
            Some("--dest") => {
                opts.dest = Some(args.next().ok_or("--dest needs a folder")?.into());
            }
            Some("--start-menu") => {
                opts.start_menu = Some(args.next().ok_or("--start-menu needs a folder")?.into());
            }
            _ => {
                return Err(format!(
                    "unknown option {}. Options: --quiet, --dest <folder>, --start-menu <folder>",
                    arg.to_string_lossy()
                ));
            }
        }
    }
    Ok(opts)
}

/// Dialogs, or stderr lines with `--quiet`.
struct Ui {
    quiet: bool,
}

impl Ui {
    fn error(&self, text: &str) {
        if self.quiet {
            eprintln!("AgentBook Setup: {text}");
        } else {
            os::tell(TITLE, text, Notice::Error);
        }
    }

    /// Asks the user to close AgentBook; `false` means give up.
    fn retry_while_running(&self) -> bool {
        if self.quiet {
            eprintln!("AgentBook Setup: AgentBook is running; close it and run setup again.");
            false
        } else {
            os::ask_retry(TITLE, RUNNING_MESSAGE)
        }
    }

    fn installed(&self, exe: &Path) {
        if self.quiet {
            eprintln!(
                "AgentBook Setup: AgentBook {VERSION} installed at {}",
                exe.display()
            );
            return;
        }
        let text = format!(
            "AgentBook {VERSION} is installed in\n{}\n\nIt is in the Start menu as AgentBook.\n\n\
             Open AgentBook now?",
            exe.parent().unwrap_or(exe).display()
        );
        if os::ask_yes_no(TITLE, &text)
            && let Err(e) = os::launch(exe)
        {
            os::tell(TITLE, &e.to_string(), Notice::Warning);
        }
    }
}

/// Whether an AgentBook (installed or run from anywhere) holds the single-instance lock in the
/// data folder. The lock file is only opened, never created, so a missing data folder stays
/// missing.
fn agentbook_running() -> bool {
    let lock = agentbook_platform::native()
        .data_dir()
        .join(agentbook_core::INSTANCE_LOCK_FILE);
    let Ok(file) = File::open(&lock) else {
        return false;
    };
    // A shared lock fails only while the app holds its exclusive one; dropping `file` releases it.
    matches!(file.try_lock_shared(), Err(TryLockError::WouldBlock))
}

enum Outcome {
    Installed(PathBuf),
    Cancelled,
}

fn install(ui: &Ui, dest_dir: &Path, menu_dir: &Path) -> Result<Outcome, String> {
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Cannot create {}: {e}", dest_dir.display()))?;
    let exe = dest_dir.join(EXE_NAME);
    let staged = dest_dir.join(STAGED_NAME);
    std::fs::write(&staged, PAYLOAD)
        .map_err(|e| format!("Cannot write {}: {e}", staged.display()))?;
    let cancel = || {
        let _ = std::fs::remove_file(&staged);
        Ok(Outcome::Cancelled)
    };
    loop {
        if agentbook_running() {
            if ui.retry_while_running() {
                continue;
            }
            return cancel();
        }
        match std::fs::rename(&staged, &exe) {
            Ok(()) => break,
            Err(e) if os::is_file_in_use(&e) => {
                if !ui.retry_while_running() {
                    return cancel();
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&staged);
                return Err(format!("Cannot replace {}: {e}", exe.display()));
            }
        }
    }
    std::fs::create_dir_all(menu_dir)
        .map_err(|e| format!("Cannot create {}: {e}", menu_dir.display()))?;
    os::create_shortcut(
        &menu_dir.join(SHORTCUT_NAME),
        &exe,
        dest_dir,
        SHORTCUT_DESCRIPTION,
    )
    .map_err(|e| format!("AgentBook was copied, but the Start-menu shortcut failed: {e}"))?;
    Ok(Outcome::Installed(exe))
}

fn main() -> ExitCode {
    let opts = match parse_args(std::env::args_os().skip(1)) {
        Ok(o) => o,
        Err(m) => {
            Ui { quiet: true }.error(&m);
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let ui = Ui { quiet: opts.quiet };
    if PAYLOAD.is_empty() {
        ui.error(
            "This AgentBook-Setup.exe was built without AgentBook.exe inside. Build it with \
             `npm run build` in agentbook/.",
        );
        return ExitCode::from(EXIT_FAILED);
    }
    let Some(dest_dir) = opts
        .dest
        .or_else(|| os::user_programs_dir().map(|p| p.join("AgentBook")))
    else {
        ui.error("Cannot find the per-user programs folder (%LOCALAPPDATA%\\Programs).");
        return ExitCode::from(EXIT_FAILED);
    };
    let Some(menu_dir) = opts.start_menu.or_else(os::start_menu_programs_dir) else {
        ui.error("Cannot find the Start-menu programs folder.");
        return ExitCode::from(EXIT_FAILED);
    };
    // The shortcut needs absolute paths (`--dest` / `--start-menu` may be relative).
    let (dest_dir, menu_dir) = match (
        std::path::absolute(&dest_dir),
        std::path::absolute(&menu_dir),
    ) {
        (Ok(d), Ok(m)) => (d, m),
        (Err(e), _) | (_, Err(e)) => {
            ui.error(&format!("Cannot resolve the install folders: {e}"));
            return ExitCode::from(EXIT_FAILED);
        }
    };
    match install(&ui, &dest_dir, &menu_dir) {
        Ok(Outcome::Installed(exe)) => {
            ui.installed(&exe);
            ExitCode::SUCCESS
        }
        Ok(Outcome::Cancelled) => ExitCode::from(EXIT_CANCELLED),
        Err(m) => {
            ui.error(&m);
            ExitCode::from(EXIT_FAILED)
        }
    }
}
