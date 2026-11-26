//! Choose a shared folder (FR-1): drag a folder in, Browse…, or pick a recent folder. The
//! one-time `.claude/` question is a dialog (`Dialog::ClaudeDir`).

use agentbook_core::paths::{host_basename, strip_verbatim};
use agentbook_engine::Snapshot;
use egui::{Align, Layout, RichText, Ui};

use crate::app::{App, PickFor, plural};
use crate::theme;

/// One spacing scale for the screen: between sections, from a label to its content, between rows.
const SECTION_GAP: f32 = 28.0;
const LABEL_GAP: f32 = 8.0;
const ROW_GAP: f32 = 8.0;

pub fn choose(app: &mut App, ui: &mut Ui, snap: &Snapshot) {
    ui.vertical_centered(|ui| {
        ui.set_max_width(780.0);
        ui.add_space(8.0);
        ui.label(theme::strong(
            "A virtual laptop for the agent, inside your computer",
            22.0,
        ));
        ui.add_space(2.0);
        ui.label(theme::muted(
            "Choose the folder the agent works in. It sees that folder and nothing else on your \
             computer.",
        ));
        ui.add_space(SECTION_GAP);
        let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
        let (fill, stroke) = if hovering {
            (theme::ACCENT_SOFT, theme::ACCENT)
        } else {
            (theme::SOFT, theme::BORDER_STRONG)
        };
        let frame = theme::note(fill, stroke).show(ui, |ui| {
            ui.set_width(ui.available_width());
            // Left-aligned like the recent rows below: the icon in the same left column, the
            // text and the Browse button in the same text column.
            ui.with_layout(Layout::top_down(Align::Min), |ui| {
                ui.add_space(18.0);
                ui.horizontal(|ui| {
                    // `note` has a 12 px side margin and `card` 14 px: line the columns up.
                    ui.add_space(2.0);
                    // One line: "Drag a folder here, or [Browse…]", centred on the icon.
                    with_icon(ui, 30.0, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("Drag a folder here, or").size(15.0));
                            let label = if app.picking() {
                                "Choosing…"
                            } else {
                                "Browse…"
                            };
                            if ui
                                .add_enabled_ui(!app.picking(), |ui| theme::primary(ui, label))
                                .inner
                                .clicked()
                            {
                                app.pick_folder(PickFor::AddFolder);
                            }
                        });
                    });
                });
                ui.add_space(18.0);
            });
        });
        // A double click anywhere on the drop area also opens the picker. It is read from the raw
        // input, not via `frame.response.interact(Sense::click())`: a click sense registered on the
        // frame after its children sits on top of them in egui's hit test and swallows every click
        // on the Browse button.
        let double_clicked = ui.input(|i| {
            i.pointer
                .button_double_clicked(egui::PointerButton::Primary)
        });
        if double_clicked && frame.response.contains_pointer() && !app.picking() {
            app.pick_folder(PickFor::AddFolder);
        }
        if snap.recent.is_empty() {
            return;
        }
        ui.add_space(SECTION_GAP);
        ui.with_layout(Layout::top_down(Align::Min), |ui| {
            ui.label(theme::caption("Recent folders"));
            ui.add_space(LABEL_GAP);
            for path in &snap.recent {
                let laptops = snap
                    .folders
                    .iter()
                    .find(|f| {
                        strip_verbatim(&f.folder.path).eq_ignore_ascii_case(&strip_verbatim(path))
                    })
                    .map(|f| App::laptops_of(snap, &f.folder.id).len());
                let row = theme::card(egui::Color32::WHITE, theme::BORDER).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        // Two lines, both left-aligned: the folder name, then its path under it.
                        with_icon(ui, 18.0, |ui| {
                            // Not selectable: a selectable label takes the click (it starts a
                            // text selection) and the row would not open.
                            ui.add(
                                egui::Label::new(
                                    theme::strong(host_basename(path), 14.0).color(theme::ACCENT),
                                )
                                .selectable(false),
                            );
                            ui.add(
                                egui::Label::new(theme::small(shorten_middle(path, 72)))
                                    .truncate()
                                    .selectable(false),
                            );
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let words = match laptops {
                                Some(0) | None => "no laptops".to_string(),
                                Some(n) => plural(n, "laptop", "laptops"),
                            };
                            badge(ui, &words);
                        });
                    });
                });
                let r = row
                    .response
                    .interact(egui::Sense::click())
                    .on_hover_cursor(egui::CursorIcon::PointingHand)
                    .on_hover_text(path);
                if r.clicked() {
                    app.add_folder(path);
                }
                ui.add_space(ROW_GAP);
            }
        });
    });
}

/// Width of the icon column shared by the drop area and the recent rows, so their icons and their
/// text start at the same x.
const ICON_COL: f32 = 46.0;

/// A folder icon in the left column, centred on the height of `body` (a left-aligned column of
/// lines to its right). The icon is painted after `body`, when that height is known: placed first,
/// egui would centre it on the first line only.
fn with_icon(ui: &mut Ui, size: f32, body: impl FnOnce(&mut Ui)) {
    let left = ui.cursor().min.x;
    ui.add_space(ICON_COL - ui.spacing().item_spacing.x);
    let rect = ui.vertical(body).response.rect;
    ui.painter().text(
        egui::pos2(left, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "📁",
        egui::FontId::proportional(size),
        theme::ACCENT,
    );
}

/// The laptop count as a small blue pill, so it does not read as part of the path.
/// Painted by hand at its text's size: a `Frame` here would stretch to the row's full height.
fn badge(ui: &mut Ui, text: &str) {
    let galley = ui.painter().layout_no_wrap(
        text.to_string(),
        egui::FontId::proportional(12.0),
        theme::ACCENT,
    );
    let size = galley.size() + egui::vec2(16.0, 6.0);
    let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
    ui.painter()
        .rect_filled(rect, size.y / 2.0, theme::ACCENT_SOFT);
    ui.painter()
        .galley(rect.center() - galley.size() / 2.0, galley, theme::ACCENT);
}

/// Keeps the start (drive) and the end (the folders that tell rows apart) of a long path and
/// replaces the middle with "…". The full path is in the row's tooltip.
fn shorten_middle(path: &str, max_chars: usize) -> String {
    let chars: Vec<char> = path.chars().collect();
    if chars.len() <= max_chars {
        return path.to_string();
    }
    let head = 8.min(max_chars / 4);
    let tail = max_chars - head - 1;
    let mut out: String = chars[..head].iter().collect();
    out.push('…');
    out.extend(&chars[chars.len() - tail..]);
    out
}
