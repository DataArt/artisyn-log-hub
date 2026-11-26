//! What `AgentBook-Setup.exe` needs from Windows: the per-user install and Start-menu folders, a
//! Start-menu shortcut (`IShellLinkW`), message boxes, "file in use" detection and starting the
//! installed app. Per-user only: nothing here needs admin rights.

use std::io;
use std::path::{Path, PathBuf};

use ::windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize, IPersistFile,
};
use ::windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use ::windows::core::{HSTRING, Interface};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
};
use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, FOLDERID_Programs};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    IDRETRY, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_ICONWARNING, MB_OK,
    MB_RETRYCANCEL, MB_SETFOREGROUND, MB_YESNO, MessageBoxW,
};

use super::wide::{known_folder, to_wide};
use crate::PlatformError;

/// The per-user programs folder, `%LOCALAPPDATA%\Programs` (where per-user installers put apps).
pub fn user_programs_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_LocalAppData)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .map(|p| p.join("Programs"))
}

/// The current user's Start-menu programs folder.
pub fn start_menu_programs_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Programs)
}

/// The icon of a message box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    Info,
    Warning,
    Error,
}

fn message_box(title: &str, text: &str, style: u32) -> i32 {
    let title = to_wide(title);
    let text = to_wide(text);
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call; no owner window.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            style | MB_SETFOREGROUND,
        )
    }
}

/// Shows a message with one OK button.
pub fn tell(title: &str, text: &str, notice: Notice) {
    let icon = match notice {
        Notice::Info => MB_ICONINFORMATION,
        Notice::Warning => MB_ICONWARNING,
        Notice::Error => MB_ICONERROR,
    };
    message_box(title, text, MB_OK | icon);
}

/// Asks Retry / Cancel; `true` for Retry.
pub fn ask_retry(title: &str, text: &str) -> bool {
    message_box(title, text, MB_RETRYCANCEL | MB_ICONWARNING) == IDRETRY
}

/// Asks Yes / No; `true` for Yes.
pub fn ask_yes_no(title: &str, text: &str) -> bool {
    message_box(title, text, MB_YESNO | MB_ICONQUESTION) == IDYES
}

/// Whether a file error means another process has the file open (a running exe cannot be
/// replaced or deleted).
pub fn is_file_in_use(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error().map(|c| c as u32),
        Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION | ERROR_ACCESS_DENIED)
    )
}

/// Creates or replaces the shortcut `lnk` to `target`, started in `working_dir`, with
/// `description` as its tooltip and the target's own icon.
pub fn create_shortcut(
    lnk: &Path,
    target: &Path,
    working_dir: &Path,
    description: &str,
) -> Result<(), PlatformError> {
    let fail = |call: &'static str, e: ::windows::core::Error| {
        PlatformError::Other(format!(
            "{call} failed: {} ({:#010x})",
            e.message(),
            e.code().0
        ))
    };
    // SAFETY: COM is initialised for this thread and uninitialised again below only when this
    // call initialised it; every interface is released (dropped) before that.
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| fail("CoCreateInstance(ShellLink)", e))?;
            let target_h = HSTRING::from(target);
            link.SetPath(&target_h)
                .map_err(|e| fail("IShellLinkW::SetPath", e))?;
            link.SetWorkingDirectory(&HSTRING::from(working_dir))
                .map_err(|e| fail("IShellLinkW::SetWorkingDirectory", e))?;
            link.SetDescription(&HSTRING::from(description))
                .map_err(|e| fail("IShellLinkW::SetDescription", e))?;
            link.SetIconLocation(&target_h, 0)
                .map_err(|e| fail("IShellLinkW::SetIconLocation", e))?;
            let file: IPersistFile = link
                .cast()
                .map_err(|e| fail("IShellLinkW as IPersistFile", e))?;
            file.Save(&HSTRING::from(lnk), true)
                .map_err(|e| fail("IPersistFile::Save", e))
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        result
    }
}

/// Starts `exe` detached from the installer (the installer exits right after).
pub fn launch(exe: &Path) -> Result<(), PlatformError> {
    let dir = exe.parent().unwrap_or(Path::new("."));
    std::process::Command::new(exe)
        .current_dir(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| PlatformError::Other(format!("could not start {}: {e}", exe.display())))
}
