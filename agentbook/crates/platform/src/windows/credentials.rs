//! Windows Credential Manager: generic credentials whose target name is the External surface name
//! (`AgentBook/<folderId>/<NAME>`, `AgentBook/<folderId>/<laptopId>/<NAME>`), value as UTF-8,
//! persisted for this user on this computer (not roaming).

use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
use windows_sys::Win32::Security::Credentials::{
    CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW,
    CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW,
};

use super::wide::{from_wide_ptr, to_wide};
use crate::PlatformError;

/// The user name shown for AgentBook's entries in Credential Manager.
const USER_NAME: &str = "AgentBook";

fn last_error(call: &'static str) -> PlatformError {
    // SAFETY: reads the calling thread's last-error value.
    let code = unsafe { GetLastError() };
    PlatformError::Os { call, code }
}

fn check_target(target: &str) -> Result<(), PlatformError> {
    if target.is_empty() || target.contains('\0') || target.contains('*') {
        return Err(PlatformError::Other(format!(
            "invalid credential name {target:?}"
        )));
    }
    Ok(())
}

pub fn get(target: &str) -> Result<Option<String>, PlatformError> {
    check_target(target)?;
    let name = to_wide(target);
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `name` is NUL-terminated; `cred` receives a buffer freed with CredFree below.
    let ok = unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
    if ok == 0 {
        let err = last_error("CredReadW");
        return match err {
            PlatformError::Os { code, .. } if code == ERROR_NOT_FOUND => Ok(None),
            other => Err(other),
        };
    }
    // SAFETY: on success `cred` points to a valid CREDENTIALW whose blob has
    // CredentialBlobSize bytes; it is copied before the buffer is freed.
    let bytes = unsafe {
        let c = &*cred;
        let bytes = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
        };
        CredFree(cred as *const _);
        bytes
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| PlatformError::Other(format!("credential {target} is not UTF-8 text")))
}

pub fn set(target: &str, value: &str) -> Result<(), PlatformError> {
    check_target(target)?;
    if value.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(PlatformError::Other(format!(
            "the value is too long for the Windows credential store ({} bytes, at most {})",
            value.len(),
            CRED_MAX_CREDENTIAL_BLOB_SIZE
        )));
    }
    let mut name = to_wide(target);
    let mut user = to_wide(USER_NAME);
    let mut blob = value.as_bytes().to_vec();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: name.as_mut_ptr(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: if blob.is_empty() {
            std::ptr::null_mut()
        } else {
            blob.as_mut_ptr()
        },
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: user.as_mut_ptr(),
        ..Default::default()
    };
    // SAFETY: every pointer in `cred` points into a buffer that outlives the call.
    let ok = unsafe { CredWriteW(&cred, 0) };
    blob.fill(0);
    if ok == 0 {
        return Err(last_error("CredWriteW"));
    }
    Ok(())
}

pub fn delete(target: &str) -> Result<bool, PlatformError> {
    check_target(target)?;
    let name = to_wide(target);
    // SAFETY: `name` is NUL-terminated and outlives the call.
    let ok = unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 {
        return match last_error("CredDeleteW") {
            PlatformError::Os { code, .. } if code == ERROR_NOT_FOUND => Ok(false),
            other => Err(other),
        };
    }
    Ok(true)
}

pub fn list(prefix: &str) -> Result<Vec<String>, PlatformError> {
    if prefix.is_empty() || prefix.contains('*') || prefix.contains('\0') {
        return Err(PlatformError::Other(format!(
            "invalid credential prefix {prefix:?}"
        )));
    }
    let filter = to_wide(format!("{prefix}*"));
    let mut count: u32 = 0;
    let mut creds: *mut *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `filter` is NUL-terminated; `creds` receives an array freed with CredFree below.
    let ok = unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut creds) };
    if ok == 0 {
        return match last_error("CredEnumerateW") {
            PlatformError::Os { code, .. } if code == ERROR_NOT_FOUND => Ok(Vec::new()),
            other => Err(other),
        };
    }
    let mut names = Vec::with_capacity(count as usize);
    // SAFETY: on success `creds` is an array of `count` valid CREDENTIALW pointers.
    unsafe {
        for i in 0..count as usize {
            let c = &**creds.add(i);
            if c.Type != CRED_TYPE_GENERIC {
                continue;
            }
            let name = from_wide_ptr(c.TargetName).to_string_lossy().into_owned();
            // The filter matches case-insensitively; keep only exact-prefix names.
            if name.starts_with(prefix) {
                names.push(name);
            }
        }
        CredFree(creds as *const _);
    }
    names.sort();
    Ok(names)
}
