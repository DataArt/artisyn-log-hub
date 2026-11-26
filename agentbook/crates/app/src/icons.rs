//! The kawaii AgentBook laptop (FR-11) and the About picture: pre-rendered mascot pictures
//! embedded in the exe. The app has no PNG decoder (no image crate, fewer licences to check), so
//! `scripts/make-images.ps1` turns the source PNGs into raw RGBA files (`images/*.rgba`: width and
//! height as u32 LE, then RGBA bytes) once. Each picture becomes an egui texture on first use.

use egui::{Color32, ColorImage, Context, Id, Rect, Response, Sense, TextureHandle, Ui, Vec2};

/// The state the laptop face shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Face {
    Working,
    Sleeping,
    GettingEquipment,
    NotStarted,
    /// On the Wake up button: the laptop with an alarm clock and a coffee.
    WakingUp,
}

/// Icon widths in points.
pub const CARD: f32 = 54.0;
pub const TILE: f32 = 36.0;
pub const BUTTON: f32 = 21.0;

/// A picture the app embeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Picture {
    Laptop(Face),
    About,
}

fn bytes(picture: Picture) -> &'static [u8] {
    match picture {
        Picture::About => include_bytes!("../images/about.rgba"),
        Picture::Laptop(Face::Working) => include_bytes!("../images/laptop-working.rgba"),
        Picture::Laptop(Face::Sleeping) => include_bytes!("../images/laptop-sleeping.rgba"),
        Picture::Laptop(Face::GettingEquipment) => {
            include_bytes!("../images/laptop-equipment.rgba")
        }
        Picture::Laptop(Face::NotStarted) => include_bytes!("../images/laptop-not-started.rgba"),
        Picture::Laptop(Face::WakingUp) => include_bytes!("../images/laptop-wake-up.rgba"),
    }
}

/// The picture's texture, uploaded once per context and kept in egui's temp memory.
pub fn texture(ctx: &Context, picture: Picture) -> TextureHandle {
    let id = Id::new(("agentbook-picture", picture));
    if let Some(t) = ctx.data(|d| d.get_temp::<TextureHandle>(id)) {
        return t;
    }
    let raw = bytes(picture);
    let w = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    let h = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
    let image = ColorImage::from_rgba_unmultiplied([w, h], &raw[8..8 + w * h * 4]);
    let t = ctx.load_texture(
        format!("agentbook-{picture:?}"),
        image,
        egui::TextureOptions::LINEAR,
    );
    ctx.data_mut(|d| d.insert_temp(id, t.clone()));
    t
}

/// The window's title-bar and taskbar icon: the working laptop.
pub fn window_icon() -> Option<winit::window::Icon> {
    let raw = bytes(Picture::Laptop(Face::Working));
    let w = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
    let h = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]);
    winit::window::Icon::from_rgba(raw[8..].to_vec(), w, h).ok()
}

/// The picture's width / height.
pub fn aspect(picture: Picture) -> f32 {
    let raw = bytes(picture);
    let w = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f32;
    let h = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]) as f32;
    w / h
}

/// Allocates a `width`-wide square icon and paints the laptop in it.
pub fn laptop(ui: &mut Ui, face: Face, width: f32) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(width), Sense::hover());
    paint(ui.painter(), rect, face);
    response
}

/// Paints the laptop centred in `rect`. The picture is square; in a flat rect (the 3:2 button
/// slots) it takes the full width and overhangs the rect a little above and below.
pub fn paint(painter: &egui::Painter, rect: Rect, face: Face) {
    let side = rect.width().min(rect.height() * 1.5);
    let target = Rect::from_center_size(rect.center(), Vec2::splat(side));
    let t = texture(painter.ctx(), Picture::Laptop(face));
    painter.image(
        t.id(),
        target,
        Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
        Color32::WHITE,
    );
}
