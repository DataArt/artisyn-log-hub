//! A private key readable only by the current user: the PoC recipe
//! (`icacls <key> /inheritance:r /grant:r <user>:F`) done natively, by setting a protected DACL
//! with a single full-control entry for the current user's SID. Windows OpenSSH refuses a key
//! that anyone other than the owner, SYSTEM or Administrators can read.

use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW,
    SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetTokenInformation, NO_INHERITANCE,
    PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::wide::to_wide;
use crate::PlatformError;

fn os_error(call: &'static str) -> PlatformError {
    // SAFETY: reads the calling thread's last-error value.
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    PlatformError::Os { call, code }
}

/// The current process token's TOKEN_USER, in a buffer aligned for it.
fn token_user() -> Result<Vec<u64>, PlatformError> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo handle of the current process is always valid; `token` is closed below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(os_error("OpenProcessToken"));
    }
    let mut len: u32 = 0;
    // SAFETY: a size query with a null buffer; it fails and sets `len`.
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len) };
    let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
    // SAFETY: `buf` holds at least `len` bytes.
    let ok =
        unsafe { GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) };
    let result = if ok == 0 {
        Err(os_error("GetTokenInformation"))
    } else {
        Ok(buf)
    };
    // SAFETY: `token` was opened above.
    unsafe { CloseHandle(token) };
    result
}

pub fn restrict_to_current_user(path: &Path) -> Result<(), PlatformError> {
    if !path.is_file() {
        return Err(PlatformError::Other(format!(
            "{} is not a file",
            path.display()
        )));
    }
    let buf = token_user()?;
    // SAFETY: `buf` holds a TOKEN_USER written by GetTokenInformation and is 8-byte aligned;
    // the SID it points to lives inside `buf`, which outlives every use below.
    let sid = unsafe { (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let access = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid.cast(),
        },
    };
    let mut acl: *mut ACL = std::ptr::null_mut();
    // SAFETY: one valid entry, no old ACL; `acl` receives a LocalAlloc'd ACL freed below.
    let rc = unsafe { SetEntriesInAclW(1, &access, std::ptr::null(), &mut acl) };
    if rc != ERROR_SUCCESS {
        return Err(PlatformError::Os {
            call: "SetEntriesInAclW",
            code: rc,
        });
    }
    let name = to_wide(path);
    // SAFETY: `name` is NUL-terminated, `acl` is the ACL built above; the protected flag drops
    // every inherited entry, so the user's entry is the only one left.
    let rc = unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        )
    };
    // SAFETY: `acl` was allocated by SetEntriesInAclW.
    unsafe { LocalFree(acl.cast()) };
    if rc != ERROR_SUCCESS {
        return Err(PlatformError::Os {
            call: "SetNamedSecurityInfoW",
            code: rc,
        });
    }
    Ok(())
}
