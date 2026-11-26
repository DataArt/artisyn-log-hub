//! UI fonts from the macOS system font folders. Only single-face files or collection faces whose
//! index is fixed across macOS releases are used: Arial (in `Supplemental` since Catalina, in
//! `/Library/Fonts` before) for text and headings, Helvetica as a second choice, then fallbacks for
//! symbols and the CJK, Korean, Indic and Thai scripts, then Menlo for logs. For each face the first
//! file that exists wins; faces whose files are all missing are skipped. Apple Color Emoji is left
//! out: it is a bitmap (sbix) font egui cannot draw.

use std::path::PathBuf;

use crate::{FontFile, FontRole};

/// (face name, role, candidate (file, collection index) pairs in order).
const FACES: &[(&str, FontRole, &[(&str, u32)])] = &[
    (
        "Arial",
        FontRole::Primary,
        &[
            ("/System/Library/Fonts/Supplemental/Arial.ttf", 0),
            ("/Library/Fonts/Arial.ttf", 0),
            ("/System/Library/Fonts/Helvetica.ttc", 0),
        ],
    ),
    (
        "Arial Bold",
        FontRole::Bold,
        &[
            ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
            ("/Library/Fonts/Arial Bold.ttf", 0),
        ],
    ),
    (
        "Arial Unicode MS",
        FontRole::Fallback,
        &[
            ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
            ("/Library/Fonts/Arial Unicode.ttf", 0),
        ],
    ),
    (
        "Apple Symbols",
        FontRole::Fallback,
        &[("/System/Library/Fonts/Apple Symbols.ttf", 0)],
    ),
    (
        "Hiragino Sans GB",
        FontRole::Fallback,
        &[("/System/Library/Fonts/Hiragino Sans GB.ttc", 0)],
    ),
    (
        "Apple SD Gothic Neo",
        FontRole::Fallback,
        &[("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0)],
    ),
    (
        "Kohinoor",
        FontRole::Fallback,
        &[("/System/Library/Fonts/Kohinoor.ttc", 0)],
    ),
    (
        "Thonburi",
        FontRole::Fallback,
        &[("/System/Library/Fonts/Thonburi.ttc", 0)],
    ),
    (
        "Menlo",
        FontRole::Monospace,
        &[
            ("/System/Library/Fonts/Menlo.ttc", 0),
            ("/System/Library/Fonts/Supplemental/Courier New.ttf", 0),
        ],
    ),
];

pub fn ui_fonts() -> Vec<FontFile> {
    FACES
        .iter()
        .filter_map(|(name, role, files)| {
            files
                .iter()
                .map(|(f, index)| (PathBuf::from(f), *index))
                .find(|(p, _)| p.is_file())
                .map(|(path, index)| FontFile {
                    name: (*name).to_string(),
                    path,
                    index,
                    role: *role,
                })
        })
        .collect()
}
