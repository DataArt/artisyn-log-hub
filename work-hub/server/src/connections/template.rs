//! The small template language of the provider descriptors (D7).
//!
//! - `{x}` matches one non-empty path segment.
//! - `{path}` matches one or more non-empty segments and is only allowed as the last segment.
//! - `{base}` is the whole-value placeholder: a template that is exactly `{base}` matches any
//!   non-empty value (a whole base URL).
//! - Everything else is literal.
//!
//! [`fill`] puts values back; `{branch}` and `{target}` are percent-encoded there, every other
//! value is inserted as is. [`match_line`] matches a one-line template (an SSH greeting) inside
//! any line of a text; a placeholder there is a non-empty run without whitespace.

use std::collections::BTreeMap;

/// The variables a template matched or is filled with.
pub type Vars = BTreeMap<String, String>;

/// Name of the rest placeholder (one or more segments, last only).
const REST: &str = "path";
/// Name of the whole-value placeholder.
const WHOLE: &str = "base";
/// Variables that [`fill`] percent-encodes.
const ENCODED: [&str; 2] = ["branch", "target"];

/// The placeholder name when `segment` is exactly `{name}`.
fn placeholder(segment: &str) -> Option<&str> {
    let name = segment.strip_prefix('{')?.strip_suffix('}')?;
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Some(name)
    } else {
        None
    }
}

/// Matches `path` (segments separated by `/`) against `tmpl`; `Some` holds the variables.
pub fn match_template(tmpl: &str, path: &str) -> Option<Vars> {
    let mut vars = Vars::new();
    if placeholder(tmpl) == Some(WHOLE) {
        if path.is_empty() {
            return None;
        }
        vars.insert(WHOLE.to_string(), path.to_string());
        return Some(vars);
    }
    let t: Vec<&str> = tmpl.split('/').collect();
    let p: Vec<&str> = path.split('/').collect();
    for (i, seg) in t.iter().enumerate() {
        match placeholder(seg) {
            Some(REST) if i == t.len() - 1 => {
                let rest = p.get(i..)?;
                if rest.is_empty() || rest.iter().any(|s| s.is_empty()) {
                    return None;
                }
                vars.insert(REST.to_string(), rest.join("/"));
                return Some(vars);
            }
            Some(name) => {
                let value = p.get(i).filter(|v| !v.is_empty())?;
                vars.insert(name.to_string(), (*value).to_string());
            }
            None => {
                if p.get(i) != Some(seg) {
                    return None;
                }
            }
        }
    }
    (p.len() == t.len()).then_some(vars)
}

/// Percent-encodes everything outside the unreserved set (RFC 3986) and `/`.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// One piece of a template: literal text or a `{name}` placeholder.
enum Part<'a> {
    Lit(&'a str),
    Var(&'a str),
}

/// Splits a template into literal and placeholder parts. A `{` that does not start a valid
/// placeholder stays literal.
fn parts(tmpl: &str) -> Vec<Part<'_>> {
    let mut out = Vec::new();
    let mut lit_start = 0;
    let mut i = 0;
    while i < tmpl.len() {
        if tmpl[i..].starts_with('{')
            && let Some(close) = tmpl[i..].find('}')
            && let Some(name) = placeholder(&tmpl[i..i + close + 1])
        {
            if lit_start < i {
                out.push(Part::Lit(&tmpl[lit_start..i]));
            }
            out.push(Part::Var(name));
            i += close + 1;
            lit_start = i;
            continue;
        }
        i += tmpl[i..].chars().next().map_or(1, char::len_utf8);
    }
    if lit_start < tmpl.len() {
        out.push(Part::Lit(&tmpl[lit_start..]));
    }
    out
}

/// Fills the placeholders of `tmpl` from `vars`; `branch` and `target` are percent-encoded.
/// A placeholder without a value stays as written.
pub fn fill(tmpl: &str, vars: &Vars) -> String {
    let mut out = String::with_capacity(tmpl.len());
    for part in parts(tmpl) {
        match part {
            Part::Lit(s) => out.push_str(s),
            Part::Var(name) => match vars.get(name) {
                Some(v) if ENCODED.contains(&name) => out.push_str(&percent_encode(v)),
                Some(v) => out.push_str(v),
                None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
            },
        }
    }
    out
}

/// Matches `parts` at the very start of `s` (the rest of `s` after the last part is ignored).
fn match_at(parts: &[Part<'_>], s: &str, vars: &mut Vars) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return true;
    };
    match first {
        Part::Lit(lit) => s
            .strip_prefix(lit)
            .is_some_and(|tail| match_at(rest, tail, vars)),
        Part::Var(name) => {
            // The longest value a placeholder may take: a run without whitespace.
            let run = s.find(char::is_whitespace).unwrap_or(s.len());
            if run == 0 {
                return false;
            }
            if rest.is_empty() {
                vars.insert((*name).to_string(), s[..run].to_string());
                return true;
            }
            // Shortest value first, so `{user}!` stops at the first `!`.
            for (end, _) in s[..run].char_indices().skip(1).chain([(run, ' ')]) {
                let mut attempt = vars.clone();
                attempt.insert((*name).to_string(), s[..end].to_string());
                if match_at(rest, &s[end..], &mut attempt) {
                    *vars = attempt;
                    return true;
                }
            }
            false
        }
    }
}

/// Finds `tmpl` anywhere inside one line of `text` (first matching line wins).
pub fn match_line(tmpl: &str, text: &str) -> Option<Vars> {
    let parts = parts(tmpl);
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        for (start, _) in line.char_indices() {
            let mut vars = Vars::new();
            if match_at(&parts, &line[start..], &mut vars) {
                return Some(vars);
            }
        }
    }
    None
}
