//! UI fonts from the system font folder: Segoe UI (and its semibold face), then fallbacks for symbols, emoji and the CJK,
//! Indic and Thai scripts, then a monospace font. egui's bundled fonts stay disabled (licence
//! allowlist), so these are the only fonts the UI has. For each face the first file that exists
//! wins; faces whose files are all missing are skipped.

use std::path::PathBuf;

use windows_sys::Win32::UI::Shell::FOLDERID_Fonts;

use super::wide::known_folder;
use crate::{FontFile, FontRole};

/// (face name, role, candidate files in order).
const FACES: &[(&str, FontRole, &[&str])] = &[
    ("Segoe UI", FontRole::Primary, &["segoeui.ttf"]),
    (
        "Segoe UI Semibold",
        FontRole::Bold,
        &["seguisb.ttf", "segoeuib.ttf"],
    ),
    ("Segoe UI Symbol", FontRole::Fallback, &["seguisym.ttf"]),
    ("Segoe UI Emoji", FontRole::Fallback, &["seguiemj.ttf"]),
    (
        "Microsoft YaHei",
        FontRole::Fallback,
        &["msyh.ttc", "msyh.ttf", "simsun.ttc"],
    ),
    (
        "Microsoft JhengHei",
        FontRole::Fallback,
        &["msjh.ttc", "msjh.ttf"],
    ),
    (
        "Yu Gothic",
        FontRole::Fallback,
        &["YuGothM.ttc", "YuGothR.ttc", "meiryo.ttc", "msgothic.ttc"],
    ),
    ("Malgun Gothic", FontRole::Fallback, &["malgun.ttf"]),
    (
        "Nirmala UI",
        FontRole::Fallback,
        &["Nirmala.ttc", "Nirmala.ttf"],
    ),
    ("Leelawadee UI", FontRole::Fallback, &["LeelawUI.ttf"]),
    ("Ebrima", FontRole::Fallback, &["ebrima.ttf"]),
    (
        "Consolas",
        FontRole::Monospace,
        &["consola.ttf", "CascadiaMono.ttf"],
    ),
];

fn fonts_dir() -> PathBuf {
    known_folder(&FOLDERID_Fonts)
        .or_else(|| std::env::var_os("WINDIR").map(|w| PathBuf::from(w).join("Fonts")))
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\Fonts"))
}

pub fn ui_fonts() -> Vec<FontFile> {
    let dir = fonts_dir();
    FACES
        .iter()
        .filter_map(|(name, role, files)| {
            files
                .iter()
                .map(|f| dir.join(f))
                .find(|p| p.is_file())
                .map(|path| FontFile {
                    name: (*name).to_string(),
                    path,
                    index: 0,
                    role: *role,
                })
        })
        .collect()
}
