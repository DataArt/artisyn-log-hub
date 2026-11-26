//! The Windows clipboard (Unicode text only): Copy log, and copy and paste in the UI's text
//! fields. The UI does not use egui-winit's clipboard backend (its Windows crate is BSL-1.0, outside
//! the licence allowlist), so it comes through here.

use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GetLastError, GlobalFree, HANDLE};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

use super::wide::from_wide_ptr;
use crate::PlatformError;

/// Opens the clipboard, retrying briefly: another program may hold it for a moment.
fn open() -> Result<(), PlatformError> {
    for _ in 0..10 {
        // SAFETY: a null owner window is allowed.
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return Ok(());
        }
        sleep(Duration::from_millis(20));
    }
    Err(PlatformError::Os {
        call: "OpenClipboard",
        // SAFETY: no preconditions.
        code: unsafe { GetLastError() },
    })
}

pub fn set_text(text: &str) -> Result<(), PlatformError> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();
    open()?;
    let result = (|| {
        // SAFETY: the clipboard is open by this thread.
        if unsafe { EmptyClipboard() } == 0 {
            return Err(PlatformError::Os {
                call: "EmptyClipboard",
                // SAFETY: no preconditions.
                code: unsafe { GetLastError() },
            });
        }
        // SAFETY: a plain movable allocation of `bytes` bytes.
        let mem = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
        if mem.is_null() {
            return Err(PlatformError::Os {
                call: "GlobalAlloc",
                // SAFETY: no preconditions.
                code: unsafe { GetLastError() },
            });
        }
        // SAFETY: `mem` is a live movable block; the lock gives a pointer to `bytes` bytes.
        let ptr = unsafe { GlobalLock(mem) } as *mut u16;
        if ptr.is_null() {
            // SAFETY: `mem` was allocated above and is not owned by the clipboard.
            unsafe { GlobalFree(mem) };
            return Err(PlatformError::Os {
                call: "GlobalLock",
                // SAFETY: no preconditions.
                code: unsafe { GetLastError() },
            });
        }
        // SAFETY: `ptr` points to `wide.len()` u16 slots, the source has as many.
        unsafe {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            GlobalUnlock(mem);
        }
        // SAFETY: on success the clipboard owns `mem`; on failure it is still ours to free.
        if unsafe { SetClipboardData(u32::from(CF_UNICODETEXT), mem as HANDLE) }.is_null() {
            // SAFETY: as above.
            let code = unsafe { GetLastError() };
            // SAFETY: as above.
            unsafe { GlobalFree(mem) };
            return Err(PlatformError::Os {
                call: "SetClipboardData",
                code,
            });
        }
        Ok(())
    })();
    // SAFETY: the clipboard was opened above.
    unsafe { CloseClipboard() };
    result
}

pub fn get_text() -> Option<String> {
    // SAFETY: no preconditions.
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT)) } == 0 {
        return None;
    }
    open().ok()?;
    let text = (|| {
        // SAFETY: the clipboard is open; the handle stays owned by the clipboard.
        let handle = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT)) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: a CF_UNICODETEXT handle is a global memory block holding a NUL-terminated
        // UTF-16 string.
        let ptr = unsafe { GlobalLock(handle as _) } as *const u16;
        if ptr.is_null() {
            return None;
        }
        // SAFETY: as above; unlocked right after the copy.
        let text = unsafe { from_wide_ptr(ptr) };
        // SAFETY: locked above.
        unsafe { GlobalUnlock(handle as _) };
        Some(text.to_string_lossy().into_owned())
    })();
    // SAFETY: the clipboard was opened above.
    unsafe { CloseClipboard() };
    text
}
