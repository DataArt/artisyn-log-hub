//! UTF-16 string helpers and known folders.

use std::ffi::OsStr;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;

use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;
use windows_sys::core::{GUID, PWSTR};

/// A NUL-terminated UTF-16 copy of `s`.
pub fn to_wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// The string at a NUL-terminated UTF-16 pointer (empty for null).
///
/// # Safety
/// `p` is null or points to a NUL-terminated UTF-16 string.
pub unsafe fn from_wide_ptr(p: *const u16) -> std::ffi::OsString {
    if p.is_null() {
        return std::ffi::OsString::new();
    }
    let mut len = 0;
    // SAFETY: the caller guarantees a NUL terminator, so every read up to it is in bounds.
    unsafe {
        while *p.add(len) != 0 {
            len += 1;
        }
        std::ffi::OsString::from_wide(std::slice::from_raw_parts(p, len))
    }
}

/// A known folder of the current user (`FOLDERID_*`).
pub fn known_folder(id: &GUID) -> Option<PathBuf> {
    let mut path: PWSTR = std::ptr::null_mut();
    // SAFETY: `path` receives a CoTaskMemAlloc'd string, freed below whatever the result.
    let hr = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut path) };
    let out = if hr >= 0 && !path.is_null() {
        // SAFETY: on success `path` is a NUL-terminated UTF-16 string.
        Some(PathBuf::from(unsafe { from_wide_ptr(path) }))
    } else {
        None
    };
    // SAFETY: freeing null is allowed; otherwise it is the buffer the shell allocated.
    unsafe { CoTaskMemFree(path as *const _) };
    out.filter(|p| !p.as_os_str().is_empty())
}
