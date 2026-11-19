//! Relative paths inside a view (D8, algorithm `workhub-repo-path`).

use crate::error::ApiError;

/// Longest accepted input, in bytes.
pub const MAX_PATH_BYTES: usize = 4096;

/// Normalizes a `/`-separated path relative to the view root. `""` is the root itself.
///
/// One leading `./` and one trailing `/` are dropped. Rejected with `invalid_path`: more than
/// 4096 bytes, an absolute path, `\`, NUL, an empty segment in the middle, `.` or `..` segments
/// and any `.git` segment.
pub fn normalize(input: &str) -> Result<String, ApiError> {
    if input.len() > MAX_PATH_BYTES {
        return Err(ApiError::invalid_path());
    }
    let path = input.strip_prefix("./").unwrap_or(input);
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(ApiError::invalid_path());
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty() {
        return Ok(String::new());
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment == ".git" {
            return Err(ApiError::invalid_path());
        }
    }
    Ok(path.to_string())
}

/// The absolute container path of a normalized `rel` under the view `root`.
pub fn container_path(root: &str, rel: &str) -> String {
    let root = root.trim_end_matches('/');
    if rel.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{rel}")
    }
}
