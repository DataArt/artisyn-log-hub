//! The Windows proxy settings ("Internet Options" / Settings > Network > Proxy, per user):
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` `ProxyEnable`,
//! `ProxyServer` and `ProxyOverride`. Read only when no `HTTP(S)_PROXY` variable is set.

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
};

use super::wide::{from_wide_ptr, to_wide};
use crate::ProxySettings;

const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

fn read_dword(name: &str) -> Option<u32> {
    let key = to_wide(KEY);
    let value = to_wide(name);
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both strings are NUL-terminated UTF-16; `data` is a u32 of the size passed.
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (rc == ERROR_SUCCESS).then_some(data)
}

fn read_string(name: &str) -> Option<String> {
    let key = to_wide(KEY);
    let value = to_wide(name);
    let mut size: u32 = 0;
    // SAFETY: a null buffer asks for the size only.
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if rc != ERROR_SUCCESS || size == 0 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut bytes = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `bytes` bytes; RRF_RT_REG_SZ NUL-terminates the result.
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    // SAFETY: the buffer is NUL-terminated (zero-filled past the value).
    let s = unsafe { from_wide_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .trim()
        .to_string();
    (!s.is_empty()).then_some(s)
}

fn with_scheme(server: &str) -> String {
    if server.contains("://") {
        server.to_string()
    } else {
        format!("http://{server}")
    }
}

/// `ProxyServer` is either `host:port` (every protocol) or `http=h:p;https=h:p;…`.
fn split_server(server: &str) -> (Option<String>, Option<String>) {
    if !server.contains('=') {
        let s = with_scheme(server.trim());
        return (Some(s.clone()), Some(s));
    }
    let mut http = None;
    let mut https = None;
    for part in server.split(';') {
        if let Some((proto, addr)) = part.split_once('=') {
            let addr = addr.trim();
            if addr.is_empty() {
                continue;
            }
            match proto.trim().to_ascii_lowercase().as_str() {
                "http" => http = Some(with_scheme(addr)),
                "https" => https = Some(with_scheme(addr)),
                _ => {}
            }
        }
    }
    (http, https)
}

/// `ProxyOverride` (`<local>;*.corp;10.*`) as a `NO_PROXY` list.
fn no_proxy(overrides: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for item in overrides
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if item.eq_ignore_ascii_case("<local>") {
            out.extend(["localhost".to_string(), "127.0.0.1".to_string()]);
        } else {
            out.push(item.trim_start_matches('*').to_string());
        }
    }
    out.join(",")
}

/// The per-user Windows proxy, when it is switched on.
pub fn registry_proxy() -> Option<ProxySettings> {
    if read_dword("ProxyEnable").unwrap_or(0) == 0 {
        return None;
    }
    let server = read_string("ProxyServer")?;
    let (http, https) = split_server(&server);
    if http.is_none() && https.is_none() {
        return None;
    }
    Some(ProxySettings {
        http,
        https,
        no_proxy: read_string("ProxyOverride")
            .map(|o| no_proxy(&o))
            .filter(|s| !s.is_empty()),
    })
}
