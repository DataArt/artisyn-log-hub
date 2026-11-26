//! The built-in help (NFR Offline first): the Markdown pages in `agentbook/help/`, embedded in the
//! exe and rendered natively from CommonMark. Links of the form `help:<page>` move between pages;
//! there are no web links, so every fact a user needs ships with the tool.

use egui::{FontId, RichText, Ui};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::fonts;
use crate::theme;

/// (page id, Markdown) for every page, in the order of the page list.
const PAGES: &[(&str, &str)] = &[
    ("index", include_str!("../../../help/index.md")),
    (
        "getting-started",
        include_str!("../../../help/getting-started.md"),
    ),
    ("laptops", include_str!("../../../help/laptops.md")),
    ("folders", include_str!("../../../help/folders.md")),
    ("equipment", include_str!("../../../help/equipment.md")),
    ("variables", include_str!("../../../help/variables.md")),
    (
        "first-launch",
        include_str!("../../../help/first-launch.md"),
    ),
    (
        "prerequisites",
        include_str!("../../../help/prerequisites.md"),
    ),
];

#[derive(Debug, Clone, Default)]
struct Span {
    text: String,
    bold: bool,
    italic: bool,
    code: bool,
    link: Option<String>,
}

#[derive(Debug, Clone)]
enum Block {
    Heading(u8, Vec<Span>),
    Paragraph(Vec<Span>),
    Item {
        depth: usize,
        marker: String,
        spans: Vec<Span>,
    },
    Code(String),
    Table(Vec<Vec<Vec<Span>>>),
    Rule,
}

/// One parsed page.
pub struct Page {
    pub id: &'static str,
    pub title: String,
    blocks: Vec<Block>,
}

/// Every help page, parsed once.
pub struct Help {
    pub pages: Vec<Page>,
}

impl Help {
    pub fn load() -> Self {
        Self {
            pages: PAGES.iter().map(|(id, md)| parse(id, md)).collect(),
        }
    }

    pub fn page(&self, id: &str) -> &Page {
        self.pages
            .iter()
            .find(|p| p.id == id)
            .unwrap_or(&self.pages[0])
    }
}

fn parse(id: &'static str, md: &str) -> Page {
    let mut blocks = Vec::new();
    let mut spans: Vec<Span> = Vec::new();
    let mut style = Span::default();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut item_marker: Option<String> = None;
    let mut code: Option<String> = None;
    let mut table: Option<Vec<Vec<Vec<Span>>>> = None;
    let mut heading: Option<u8> = None;
    let push_text = |spans: &mut Vec<Span>, style: &Span, text: &str| {
        let mut s = style.clone();
        s.text = text.to_string();
        spans.push(s);
    };
    let flush_item = |blocks: &mut Vec<Block>,
                      spans: &mut Vec<Span>,
                      marker: &mut Option<String>,
                      depth: usize| {
        if let Some(m) = marker.take() {
            blocks.push(Block::Item {
                depth,
                marker: m,
                spans: std::mem::take(spans),
            });
        }
    };
    for event in Parser::new_ext(md, Options::ENABLE_TABLES) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    _ => 3,
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                blocks.push(Block::Heading(
                    heading.take().unwrap_or(3),
                    std::mem::take(&mut spans),
                ));
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                if item_marker.is_none() && table.is_none() {
                    blocks.push(Block::Paragraph(std::mem::take(&mut spans)));
                }
            }
            Event::Start(Tag::List(start)) => {
                flush_item(&mut blocks, &mut spans, &mut item_marker, lists.len());
                lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                flush_item(&mut blocks, &mut spans, &mut item_marker, lists.len());
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                flush_item(&mut blocks, &mut spans, &mut item_marker, lists.len());
                let marker = match lists.last_mut() {
                    Some(Some(n)) => {
                        let m = format!("{n}.");
                        *n += 1;
                        m
                    }
                    _ => "•".to_string(),
                };
                item_marker = Some(marker);
            }
            Event::End(TagEnd::Item) => {
                flush_item(&mut blocks, &mut spans, &mut item_marker, lists.len());
            }
            Event::Start(Tag::CodeBlock(_)) => code = Some(String::new()),
            Event::End(TagEnd::CodeBlock) => {
                blocks.push(Block::Code(code.take().unwrap_or_default()));
            }
            Event::Start(Tag::Table(_)) => table = Some(Vec::new()),
            Event::End(TagEnd::Table) => {
                blocks.push(Block::Table(table.take().unwrap_or_default()));
            }
            Event::Start(Tag::TableHead | Tag::TableRow) => {
                if let Some(t) = table.as_mut() {
                    t.push(Vec::new());
                }
            }
            Event::End(TagEnd::TableCell) => {
                if let Some(row) = table.as_mut().and_then(|t| t.last_mut()) {
                    row.push(std::mem::take(&mut spans));
                }
            }
            Event::Start(Tag::Strong) => style.bold = true,
            Event::End(TagEnd::Strong) => style.bold = false,
            Event::Start(Tag::Emphasis) => style.italic = true,
            Event::End(TagEnd::Emphasis) => style.italic = false,
            Event::Start(Tag::Link { dest_url, .. }) => style.link = Some(dest_url.to_string()),
            Event::End(TagEnd::Link) => style.link = None,
            Event::Text(t) => match code.as_mut() {
                Some(c) => c.push_str(&t),
                None => push_text(&mut spans, &style, &t),
            },
            Event::Code(t) => {
                let mut s = style.clone();
                s.code = true;
                s.text = t.to_string();
                spans.push(s);
            }
            Event::SoftBreak => push_text(&mut spans, &style, " "),
            Event::HardBreak => push_text(&mut spans, &style, "\n"),
            Event::Rule => blocks.push(Block::Rule),
            _ => {}
        }
    }
    let title = blocks
        .iter()
        .find_map(|b| match b {
            Block::Heading(1, s) => Some(s.iter().map(|x| x.text.as_str()).collect::<String>()),
            _ => None,
        })
        .unwrap_or_else(|| id.to_string());
    Page { id, title, blocks }
}

/// Renders inline spans; returns the page a clicked `help:` link points at.
fn spans_ui(ui: &mut Ui, spans: &[Span], size: f32, heading: bool) -> Option<String> {
    let mut go = None;
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing.x = 0.0;
        for s in spans {
            let mut text = if s.code {
                RichText::new(&s.text).font(FontId::monospace(size - 1.0))
            } else if s.bold || heading {
                RichText::new(&s.text).font(FontId::new(size, fonts::bold()))
            } else {
                RichText::new(&s.text).size(size)
            };
            if s.italic {
                text = text.italics();
            }
            if s.code {
                text = text.background_color(theme::BAR);
            }
            match &s.link {
                Some(link) => {
                    let r = ui.link(text.color(theme::ACCENT));
                    if r.clicked() {
                        go = link.strip_prefix("help:").map(str::to_string);
                    }
                }
                None => {
                    ui.label(text);
                }
            }
        }
    });
    go
}

/// Renders a page; returns the page id of a clicked help link.
pub fn page_ui(ui: &mut Ui, page: &Page) -> Option<String> {
    let mut go = None;
    for block in &page.blocks {
        let clicked = match block {
            Block::Heading(level, spans) => {
                let size = match level {
                    1 => 22.0,
                    2 => 17.0,
                    _ => 15.0,
                };
                ui.add_space(if *level == 1 { 0.0 } else { 10.0 });
                spans_ui(ui, spans, size, true)
            }
            Block::Paragraph(spans) => {
                let g = spans_ui(ui, spans, 14.0, false);
                ui.add_space(4.0);
                g
            }
            Block::Item {
                depth,
                marker,
                spans,
            } => {
                let mut g = None;
                ui.horizontal(|ui| {
                    ui.add_space(12.0 + 18.0 * depth.saturating_sub(1) as f32);
                    ui.label(RichText::new(marker).color(theme::MUTED));
                    ui.vertical(|ui| g = spans_ui(ui, spans, 14.0, false));
                });
                g
            }
            Block::Code(text) => {
                let lines: Vec<String> = text.lines().map(str::to_string).collect();
                theme::log_box(ui, &lines, usize::MAX);
                None
            }
            Block::Table(rows) => {
                let mut g = None;
                egui::Frame::new()
                    .stroke(egui::Stroke::new(1.0, theme::BORDER))
                    .corner_radius(6)
                    .inner_margin(8)
                    .show(ui, |ui| {
                        egui::Grid::new(ui.next_auto_id())
                            .striped(true)
                            .spacing([16.0, 6.0])
                            .show(ui, |ui| {
                                for (i, row) in rows.iter().enumerate() {
                                    for cell in row {
                                        ui.vertical(|ui| {
                                            ui.set_max_width(420.0);
                                            if let Some(x) = spans_ui(ui, cell, 13.5, i == 0) {
                                                g = Some(x);
                                            }
                                        });
                                    }
                                    ui.end_row();
                                }
                            });
                    });
                ui.add_space(6.0);
                g
            }
            Block::Rule => {
                ui.separator();
                None
            }
        };
        if clicked.is_some() {
            go = clicked;
        }
    }
    go
}
