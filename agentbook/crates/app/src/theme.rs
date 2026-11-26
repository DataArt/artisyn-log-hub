//! The look of the wireframes: a light theme, their colours, and the few widget shapes they use
//! (primary, secondary and Wake up buttons, cards, notes).

use egui::{
    Button, Color32, CornerRadius, FontId, Frame, Margin, Response, RichText, Stroke, Ui, Vec2,
};

use crate::fonts;

pub const TEXT: Color32 = Color32::from_rgb(0x09, 0x09, 0x0b);
pub const TEXT_2: Color32 = Color32::from_rgb(0x52, 0x52, 0x5b);
pub const MUTED: Color32 = Color32::from_rgb(0x71, 0x71, 0x7a);
pub const FAINT: Color32 = Color32::from_rgb(0xa1, 0xa1, 0xaa);
pub const BORDER: Color32 = Color32::from_rgb(0xe4, 0xe4, 0xe7);
pub const BORDER_STRONG: Color32 = Color32::from_rgb(0xd4, 0xd4, 0xd8);
pub const BAR: Color32 = Color32::from_rgb(0xf4, 0xf4, 0xf5);
pub const SOFT: Color32 = Color32::from_rgb(0xfa, 0xfa, 0xfa);
pub const ACCENT: Color32 = Color32::from_rgb(0x33, 0x58, 0xcc);
pub const ACCENT_SOFT: Color32 = Color32::from_rgb(0xee, 0xf1, 0xfb);
pub const GREEN: Color32 = Color32::from_rgb(0x16, 0xa3, 0x4a);
pub const GREEN_TEXT: Color32 = Color32::from_rgb(0x16, 0x65, 0x34);
pub const AMBER_FILL: Color32 = Color32::from_rgb(0xfe, 0xf3, 0xc7);
pub const AMBER_STROKE: Color32 = Color32::from_rgb(0xf5, 0x9e, 0x0b);
pub const AMBER_TEXT: Color32 = Color32::from_rgb(0x92, 0x40, 0x0e);
pub const AMBER_BORDER: Color32 = Color32::from_rgb(0xfd, 0xe6, 0x8a);
pub const AMBER_SOFT: Color32 = Color32::from_rgb(0xff, 0xfb, 0xeb);
pub const RED: Color32 = Color32::from_rgb(0x99, 0x1b, 0x1b);
pub const RED_SOFT: Color32 = Color32::from_rgb(0xfe, 0xf2, 0xf2);
pub const RED_BORDER: Color32 = Color32::from_rgb(0xfe, 0xca, 0xca);
pub const LOG_BG: Color32 = Color32::from_rgb(0x18, 0x18, 0x1b);
pub const LOG_TEXT: Color32 = Color32::from_rgb(0xe4, 0xe4, 0xe7);

/// Applies the light theme and spacing.
pub fn apply(ctx: &egui::Context) {
    ctx.set_theme(egui::Theme::Light);
    ctx.all_styles_mut(|style| {
        style.spacing.item_spacing = Vec2::new(8.0, 6.0);
        style.spacing.button_padding = Vec2::new(10.0, 4.0);
        style.spacing.interact_size.y = 26.0;
        style.visuals.panel_fill = Color32::WHITE;
        style.visuals.window_fill = Color32::WHITE;
        style.visuals.extreme_bg_color = Color32::WHITE;
        style.visuals.window_corner_radius = CornerRadius::same(10);
        style.visuals.window_stroke = Stroke::new(1.0, BORDER_STRONG);
        style.visuals.override_text_color = Some(TEXT);
        style.visuals.hyperlink_color = ACCENT;
        style.visuals.selection.bg_fill = ACCENT_SOFT;
        style.visuals.selection.stroke = Stroke::new(1.0, ACCENT);
        let w = &mut style.visuals.widgets;
        for v in [&mut w.inactive, &mut w.hovered, &mut w.active, &mut w.open] {
            v.corner_radius = CornerRadius::same(6);
        }
        w.inactive.weak_bg_fill = Color32::WHITE;
        w.inactive.bg_stroke = Stroke::new(1.0, BORDER_STRONG);
        w.hovered.weak_bg_fill = BAR;
        w.hovered.bg_stroke = Stroke::new(1.0, MUTED);
        w.active.weak_bg_fill = BORDER;
        w.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
        for (style_name, size) in [
            (egui::TextStyle::Body, 14.0),
            (egui::TextStyle::Button, 14.0),
            (egui::TextStyle::Small, 12.0),
            (egui::TextStyle::Monospace, 12.5),
            (egui::TextStyle::Heading, 20.0),
        ] {
            if let Some(font) = style.text_styles.get_mut(&style_name) {
                font.size = size;
            }
        }
        if let Some(h) = style.text_styles.get_mut(&egui::TextStyle::Heading) {
            h.family = fonts::bold();
        }
    });
}

/// Semibold text.
pub fn strong(text: impl Into<String>, size: f32) -> RichText {
    RichText::new(text).font(FontId::new(size, fonts::bold()))
}

pub fn small(text: impl Into<String>) -> RichText {
    RichText::new(text).size(12.5).color(MUTED)
}

pub fn muted(text: impl Into<String>) -> RichText {
    RichText::new(text).color(MUTED)
}

/// A section caption ("LAPTOPS (2)", "GIVEN FOLDERS").
pub fn caption(text: impl Into<String>) -> RichText {
    RichText::new(text.into().to_uppercase())
        .font(FontId::new(11.5, fonts::bold()))
        .color(MUTED)
}

/// The blue filled button (Open laptop, Get it and open, Save).
pub fn primary(ui: &mut Ui, text: impl Into<String>) -> Response {
    primary_sized(ui, text, 14.0)
}

pub fn primary_sized(ui: &mut Ui, text: impl Into<String>, size: f32) -> Response {
    ui.add(
        Button::new(
            RichText::new(text)
                .font(FontId::new(size, fonts::bold()))
                .color(Color32::WHITE),
        )
        .fill(ACCENT)
        .stroke(Stroke::NONE)
        .corner_radius(CornerRadius::same(6)),
    )
}

/// The red filled button (Remove folder, Give the whole disk).
pub fn danger(ui: &mut Ui, text: impl Into<String>) -> Response {
    ui.add(
        Button::new(
            RichText::new(text)
                .font(FontId::new(14.0, fonts::bold()))
                .color(Color32::WHITE),
        )
        .fill(RED)
        .stroke(Stroke::NONE),
    )
}

/// The white outlined button.
pub fn secondary(ui: &mut Ui, text: impl Into<String>) -> Response {
    ui.add(Button::new(RichText::new(text).color(TEXT)))
}

pub fn secondary_small(ui: &mut Ui, text: impl Into<String>) -> Response {
    ui.add(Button::new(RichText::new(text).size(12.5).color(TEXT)).small())
}

/// The amber "⏰☕ Wake up" button.
pub fn wake_up(ui: &mut Ui, size: f32) -> Response {
    // Leading spaces leave room for the waking-up laptop painted over the button's left end.
    let pad = crate::icons::BUTTON + 4.0;
    let spaces = (pad / (size * 0.27)).ceil() as usize;
    let r = ui
        .add(
            Button::new(
                RichText::new(format!("{}Wake up", " ".repeat(spaces)))
                    .font(FontId::new(size, fonts::bold()))
                    .color(AMBER_TEXT),
            )
            .fill(AMBER_FILL)
            .stroke(Stroke::new(1.0, AMBER_STROKE)),
        )
        .on_hover_text("Starts the laptop without opening Claude Desktop.");
    let side = crate::icons::BUTTON;
    let rect = egui::Rect::from_min_size(
        egui::pos2(r.rect.left() + 6.0, r.rect.center().y - side / 2.0),
        egui::vec2(side, side),
    );
    crate::icons::paint(ui.painter(), rect, crate::icons::Face::WakingUp);
    r
}

/// A blue text link-button ("⧉ like this", "Set…").
pub fn link(ui: &mut Ui, text: impl Into<String>) -> Response {
    ui.add(Button::new(RichText::new(text).size(12.5).color(ACCENT)).frame(false))
}

/// A white card with a thin border.
pub fn card(fill: Color32, stroke: Color32) -> Frame {
    Frame::new()
        .fill(fill)
        .stroke(Stroke::new(1.0, stroke))
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::same(14))
}

/// A coloured note box (warnings, failures, the Good to know box).
pub fn note(fill: Color32, stroke: Color32) -> Frame {
    Frame::new()
        .fill(fill)
        .stroke(Stroke::new(1.0, stroke))
        .corner_radius(CornerRadius::same(6))
        .inner_margin(Margin::symmetric(12, 8))
}

pub fn warning_box() -> Frame {
    note(AMBER_SOFT, AMBER_BORDER)
}

pub fn error_box() -> Frame {
    note(RED_SOFT, RED_BORDER)
}

/// The dark log box with the last lines of a build log.
pub fn log_box(ui: &mut Ui, lines: &[String], max_lines: usize) {
    Frame::new()
        .fill(LOG_BG)
        .corner_radius(CornerRadius::same(6))
        .inner_margin(Margin::same(10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            let start = lines.len().saturating_sub(max_lines);
            for line in &lines[start..] {
                ui.add(
                    egui::Label::new(RichText::new(line).monospace().color(LOG_TEXT))
                        .wrap_mode(egui::TextWrapMode::Truncate),
                );
            }
            if lines.is_empty() {
                ui.label(RichText::new("▌").monospace().color(LOG_TEXT));
            }
        });
}

/// A small status dot.
pub fn dot(ui: &mut Ui, color: Color32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(10.0), egui::Sense::hover());
    ui.painter().circle_filled(rect.center(), 4.0, color);
}

/// A progress bar in the accent colour.
pub fn progress(fraction: f32) -> egui::ProgressBar {
    egui::ProgressBar::new(fraction).fill(ACCENT)
}

/// A failure message cut to its first line and about two lines of text (Copy log has it all).
pub fn short(message: &str) -> String {
    let first = message.lines().next().unwrap_or_default().trim();
    if first.chars().count() <= 200 {
        return first.to_string();
    }
    let cut: String = first.chars().take(200).collect();
    format!("{cut}… (Copy log has the rest)")
}
