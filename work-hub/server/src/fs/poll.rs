//! `POST …/poll` (D12): the expanded directories and the open files of a view in one exec.
//!
//! The script prints, NUL-separated, for every directory either `D`, its `find` records and `E`,
//! or `M` when it is missing; then for every file `F<blob sha>` or `F-` when it is missing.
//! `find` records always contain tabs, so they never equal a marker.

use std::collections::BTreeMap;

use serde::Serialize;

use super::{Entry, FIND_SH, ViewCtx, parse_entry, run, sh_args, shell_operand, sort_entries};
use crate::error::ApiError;
use crate::repo_path;
use crate::state::AppState;

/// The poll answer: keyed by the paths exactly as the client sent them; `null` for a missing
/// (or not allowed) directory or file.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PollResult {
    pub dirs: BTreeMap<String, Option<Vec<Entry>>>,
    pub files: BTreeMap<String, Option<String>>,
}

/// `$1` = root, `$2` = number of dirs, then the dir operands, then the file operands.
const POLL_SH: &str = concat!(
    "cd \"$1\" || exit 2; n=$2; shift 2; i=0; ",
    "while [ \"$i\" -lt \"$n\" ]; do d=$1; shift; i=$((i+1)); ",
    "if [ -d \"$d\" ] && [ ! -L \"$d\" ]; then printf 'D\\0'; ",
    "FIND; printf 'E\\0'; else printf 'M\\0'; fi; done; ",
    "for f in \"$@\"; do h=-; ",
    "if [ -f \"$f\" ]; then h=$(git -c core.quotepath=off hash-object --no-filters -- \"$f\" 2>/dev/null) || h=-; ",
    "[ -n \"$h\" ] || h=-; fi; printf 'F%s\\0' \"$h\"; done"
);

/// One exec answering the listings of `dirs` and the versions of `files`.
pub async fn poll(
    st: &AppState,
    ctx: &ViewCtx,
    dirs: &[String],
    files: &[String],
) -> Result<PollResult, ApiError> {
    let mut result = PollResult::default();
    // (client key, normalized path) of the paths that are asked for; the others answer null.
    let mut ask_dirs: Vec<(String, String)> = Vec::new();
    for d in dirs {
        if result.dirs.contains_key(d) {
            continue;
        }
        if let Ok(rel) = repo_path::normalize(d) {
            ask_dirs.push((d.clone(), rel));
        }
        result.dirs.insert(d.clone(), None);
    }
    let mut ask_files: Vec<(String, String)> = Vec::new();
    for f in files {
        if result.files.contains_key(f) {
            continue;
        }
        if let Ok(rel) = repo_path::normalize(f)
            && !rel.is_empty()
        {
            ask_files.push((f.clone(), rel));
        }
        result.files.insert(f.clone(), None);
    }
    if ask_dirs.is_empty() && ask_files.is_empty() {
        return Ok(result);
    }

    let script = POLL_SH.replace("FIND", FIND_SH);
    let count = ask_dirs.len().to_string();
    let operands: Vec<String> = ask_dirs
        .iter()
        .chain(ask_files.iter())
        .map(|(_, rel)| shell_operand(rel))
        .collect();
    let mut args: Vec<&str> = vec![ctx.root, &count];
    args.extend(operands.iter().map(String::as_str));
    let out = run(ctx, st, &sh_args(&script, &args)).await?;
    if out.exit_code != 0 {
        return Err(ApiError::internal(format!(
            "poll in {} failed: {}",
            ctx.container,
            out.stderr_str()
        )));
    }

    let mut tokens = out.stdout.split(|b| *b == 0);
    for (key, rel) in &ask_dirs {
        match tokens.next() {
            Some(b"D") => {
                let mut entries = Vec::new();
                for t in tokens.by_ref() {
                    if t == b"E" {
                        break;
                    }
                    if let Some(e) = parse_entry(rel, t) {
                        entries.push(e);
                    }
                }
                sort_entries(&mut entries);
                result.dirs.insert(key.clone(), Some(entries));
            }
            Some(b"M") => {}
            other => {
                return Err(ApiError::internal(format!(
                    "poll in {}: unexpected output {:?}",
                    ctx.container,
                    other.map(String::from_utf8_lossy)
                )));
            }
        }
    }
    for (key, _) in &ask_files {
        let version = match tokens.next() {
            Some(t) if t.first() == Some(&b'F') => String::from_utf8_lossy(&t[1..]).into_owned(),
            other => {
                return Err(ApiError::internal(format!(
                    "poll in {}: unexpected output {:?}",
                    ctx.container,
                    other.map(String::from_utf8_lossy)
                )));
            }
        };
        if version != "-" {
            result.files.insert(key.clone(), Some(version));
        }
    }
    Ok(result)
}
