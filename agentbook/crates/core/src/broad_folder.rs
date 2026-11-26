//! Whole-disk, home and home-ancestor detection (FR-8): giving one of these folders hands Claude
//! (nearly) the whole disk, so the tool asks for an explicit confirmation first.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-broad-folder.md`.

use crate::paths::strip_verbatim;

/// How broad a host folder is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Breadth {
    /// An ordinary folder: no confirmation.
    Narrow,
    /// A drive root (`C:\`), a UNC share root (`\\server\share`) or `/`.
    DriveRoot,
    /// The user's home folder itself.
    Home,
    /// A folder that contains the home folder (`C:\Users`).
    HomeAncestor,
}

impl Breadth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Narrow => "none",
            Self::DriveRoot => "drive-root",
            Self::Home => "home",
            Self::HomeAncestor => "home-ancestor",
        }
    }

    /// Whether giving (or sharing) this folder needs the whole-disk confirmation.
    pub fn needs_confirmation(self) -> bool {
        self != Self::Narrow
    }
}

/// A path split into comparable components, plus whether it is a root.
struct Parts {
    windows: bool,
    components: Vec<String>,
    is_root: bool,
}

fn parts(raw: &str) -> Parts {
    let path = strip_verbatim(raw.trim());
    if path.starts_with('/') && !path.starts_with("//") {
        let components: Vec<String> = path
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".")
            .map(str::to_string)
            .collect();
        let is_root = components.is_empty();
        return Parts {
            windows: false,
            components,
            is_root,
        };
    }
    let unified = path.replace('/', "\\");
    let unc = unified.starts_with(r"\\");
    let mut components: Vec<String> = unified
        .split('\\')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(str::to_lowercase)
        .collect();
    if unc && let Some(first) = components.first_mut() {
        *first = format!(r"\\{first}");
    }
    let is_root = if unc {
        components.len() <= 2
    } else {
        components.len() == 1 && components[0].ends_with(':')
    };
    Parts {
        windows: true,
        components,
        is_root,
    }
}

/// Classifies `path` against the user's `home`. Both are absolute host paths as the folder picker
/// returns them. Windows paths compare case-insensitively with `/` and `\` alike; POSIX paths
/// (starting with one `/`) compare exactly.
pub fn classify(path: &str, home: &str) -> Breadth {
    let p = parts(path);
    if p.is_root {
        return Breadth::DriveRoot;
    }
    let h = parts(home);
    if p.windows != h.windows || h.components.is_empty() {
        return Breadth::Narrow;
    }
    if p.components == h.components {
        Breadth::Home
    } else if p.components.len() < h.components.len() && h.components.starts_with(&p.components) {
        Breadth::HomeAncestor
    } else {
        Breadth::Narrow
    }
}
