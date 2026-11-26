//! Hidden variable values in the user's login Keychain: generic passwords whose service is
//! [`SERVICE`] and whose account is the credential target name (`AgentBook/<folderId>/<NAME>`), so
//! Keychain Access shows them under one "AgentBook" service and a prefix lists them.

use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

use crate::PlatformError;

const SERVICE: &str = "AgentBook";

/// `errSecItemNotFound`.
const NOT_FOUND: i32 = -25300;

fn os_error(call: &str, e: &security_framework::base::Error) -> PlatformError {
    PlatformError::Other(format!("Keychain {call} failed: {e} ({})", e.code()))
}

pub fn get(target: &str) -> Result<Option<String>, PlatformError> {
    match get_generic_password(SERVICE, target) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| PlatformError::Other(format!("{target} is not UTF-8 text"))),
        Err(e) if e.code() == NOT_FOUND => Ok(None),
        Err(e) => Err(os_error("read", &e)),
    }
}

pub fn set(target: &str, value: &str) -> Result<(), PlatformError> {
    set_generic_password(SERVICE, target, value.as_bytes()).map_err(|e| os_error("write", &e))
}

pub fn delete(target: &str) -> Result<bool, PlatformError> {
    match delete_generic_password(SERVICE, target) {
        Ok(()) => Ok(true),
        Err(e) if e.code() == NOT_FOUND => Ok(false),
        Err(e) => Err(os_error("delete", &e)),
    }
}

pub fn list(prefix: &str) -> Result<Vec<String>, PlatformError> {
    let found = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(SERVICE)
        .load_attributes(true)
        .limit(Limit::All)
        .search();
    let results = match found {
        Ok(r) => r,
        Err(e) if e.code() == NOT_FOUND => return Ok(Vec::new()),
        Err(e) => return Err(os_error("search", &e)),
    };
    let mut names: Vec<String> = results
        .iter()
        .filter_map(|r| r.simplify_dict())
        .filter_map(|d| d.get("acct").cloned())
        .filter(|a| a.starts_with(prefix))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}
