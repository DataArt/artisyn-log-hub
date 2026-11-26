//! The UI fonts: only the OS fonts from the platform layer (egui's bundled fonts stay off for the
//! licence allowlist). The primary font, then every fallback (CJK, symbols, emoji), so Cyrillic
//! and CJK folder names render; a semibold family for headings; a monospace family for logs.

use std::collections::BTreeMap;
use std::sync::Arc;

use agentbook_platform::{FontRole, Platform};
use egui::{FontData, FontDefinitions, FontFamily};

/// The semibold family (headings, laptop names).
pub const BOLD: &str = "bold";

pub fn bold() -> FontFamily {
    FontFamily::Name(BOLD.into())
}

/// Loads the OS fonts into egui. Returns `false` when no font file could be read.
pub fn install(ctx: &egui::Context, platform: &dyn Platform) -> bool {
    let mut defs = FontDefinitions {
        font_data: BTreeMap::new(),
        families: BTreeMap::new(),
    };
    let mut primary: Vec<String> = Vec::new();
    let mut fallbacks: Vec<String> = Vec::new();
    let mut mono: Vec<String> = Vec::new();
    let mut bold_faces: Vec<String> = Vec::new();
    for font in platform.ui_fonts() {
        let Ok(bytes) = std::fs::read(&font.path) else {
            continue;
        };
        let mut data = FontData::from_owned(bytes);
        data.index = font.index;
        defs.font_data.insert(font.name.clone(), Arc::new(data));
        match font.role {
            FontRole::Primary => primary.push(font.name),
            FontRole::Fallback => fallbacks.push(font.name),
            FontRole::Monospace => mono.push(font.name),
            FontRole::Bold => bold_faces.push(font.name),
        }
    }
    if defs.font_data.is_empty() {
        return false;
    }
    let text: Vec<String> = primary.iter().chain(&fallbacks).cloned().collect();
    let text = if text.is_empty() { mono.clone() } else { text };
    let with_text = |first: &[String]| -> Vec<String> {
        let mut v: Vec<String> = first.to_vec();
        v.extend(text.iter().filter(|n| !first.contains(n)).cloned());
        v
    };
    defs.families.insert(FontFamily::Proportional, text.clone());
    defs.families
        .insert(FontFamily::Monospace, with_text(&mono));
    defs.families.insert(bold(), with_text(&bold_faces));
    ctx.set_fonts(defs);
    true
}
