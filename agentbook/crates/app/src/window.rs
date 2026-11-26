//! The native window: egui on winit + wgpu (Direct3D 12 on Windows, Vulkan as the fallback),
//! wired by hand instead of through eframe. eframe forces egui-winit's clipboard backend, whose
//! Windows crate is BSL-1.0 (outside the licence allowlist), so copy and paste go through the
//! platform layer here: copied text is taken from egui's output, and Ctrl+V / Shift+Insert inject
//! the clipboard text. (OpenGL was tried first and showed nothing on a hybrid-GPU Windows 11
//! laptop; wgpu is also eframe's default renderer.)

use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agentbook_platform::Platform;
use egui::ViewportId;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{KeyCode, ModifiersState, PhysicalKey};
use winit::window::{Window, WindowId};

/// What the window shows: called once per frame with the root `Ui`.
pub trait Frame {
    /// One-time setup (fonts, style) before the first frame.
    fn setup(&mut self, ctx: &egui::Context);
    fn ui(&mut self, ui: &mut egui::Ui);
}

/// Window options.
pub struct WindowOptions {
    pub title: String,
    /// Logical size.
    pub size: (f64, f64),
    pub min_size: (f64, f64),
}

#[derive(Debug)]
enum UserEvent {
    Repaint(Duration),
}

struct Running {
    window: Arc<Window>,
    state: egui_winit::State,
    painter: egui_wgpu::winit::Painter,
}

struct Runner<F: Frame> {
    options: WindowOptions,
    platform: Arc<dyn Platform>,
    frame: F,
    proxy: EventLoopProxy<UserEvent>,
    running: Option<Running>,
    repaint_at: Option<Instant>,
    modifiers: ModifiersState,
    error: Option<String>,
    set_up: bool,
    /// The app asked to close the window.
    close: bool,
}

impl<F: Frame> Runner<F> {
    fn start(&mut self, event_loop: &ActiveEventLoop) -> Result<Running, String> {
        let attributes = Window::default_attributes()
            .with_title(self.options.title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.options.size.0,
                self.options.size.1,
            ))
            .with_min_inner_size(winit::dpi::LogicalSize::new(
                self.options.min_size.0,
                self.options.min_size.1,
            ))
            .with_window_icon(crate::icons::window_icon())
            .with_visible(false);
        let window = Arc::new(
            event_loop
                .create_window(attributes)
                .map_err(|e| format!("cannot create the window: {e}"))?,
        );
        let ctx = egui::Context::default();
        let mut config = egui_wgpu::WgpuConfiguration::default();
        if let egui_wgpu::WgpuSetup::CreateNew(create) = &mut config.wgpu_setup {
            create.display_handle = Some(Box::new(event_loop.owned_display_handle()));
        }
        let mut painter = pollster::block_on(egui_wgpu::winit::Painter::new(
            ctx.clone(),
            config,
            false,
            egui_wgpu::RendererOptions::default(),
        ));
        pollster::block_on(painter.set_window(ViewportId::ROOT, Some(window.clone())))
            .map_err(|e| format!("cannot draw with this computer's graphics: {e}"))?;
        let proxy = self.proxy.clone();
        ctx.set_request_repaint_callback(move |info| {
            let _ = proxy.send_event(UserEvent::Repaint(info.delay));
        });
        let state = egui_winit::State::new(
            ctx,
            ViewportId::ROOT,
            event_loop,
            Some(window.scale_factor() as f32),
            event_loop.system_theme(),
            painter.max_texture_side(),
        );
        Ok(Running {
            window,
            state,
            painter,
        })
    }

    fn paint(&mut self) {
        let Some(r) = self.running.as_mut() else {
            return;
        };
        let raw = r.state.take_egui_input(&r.window);
        let ctx = r.state.egui_ctx().clone();
        if !self.set_up {
            self.frame.setup(&ctx);
            self.set_up = true;
        }
        let frame = &mut self.frame;
        let mut output = ctx.run_ui(raw, |ui| frame.ui(ui));
        // Copy goes to the OS clipboard through the platform layer.
        output.platform_output.commands.retain(|c| match c {
            egui::OutputCommand::CopyText(text) => {
                let _ = self.platform.clipboard_set(text);
                false
            }
            egui::OutputCommand::OpenUrl(url) => {
                let _ = self.platform.open_url(&url.url);
                false
            }
            egui::OutputCommand::CopyImage(_) => false,
        });
        r.state
            .handle_platform_output(&r.window, output.platform_output);
        let primitives = ctx.tessellate(output.shapes, output.pixels_per_point);
        r.painter.paint_and_update_textures(
            ViewportId::ROOT,
            output.pixels_per_point,
            [1.0, 1.0, 1.0, 1.0],
            &primitives,
            &output.textures_delta,
            Vec::new(),
            &r.window,
        );
        r.window.set_visible(true);
        for (_, viewport) in output.viewport_output {
            if viewport.repaint_delay.is_zero() {
                r.window.request_redraw();
            }
            for command in viewport.commands {
                match command {
                    egui::ViewportCommand::Title(t) => r.window.set_title(&t),
                    egui::ViewportCommand::Close => self.close = true,
                    _ => {}
                }
            }
        }
    }

    /// Ctrl+V / Shift+Insert: egui-winit has no clipboard here, so the text is injected.
    fn paste_shortcut(&mut self, event: &winit::event::KeyEvent) {
        if event.state != ElementState::Pressed {
            return;
        }
        let m = self.modifiers;
        let paste = (event.physical_key == PhysicalKey::Code(KeyCode::KeyV)
            && m.control_key()
            && !m.alt_key())
            || (event.physical_key == PhysicalKey::Code(KeyCode::Insert) && m.shift_key());
        if !paste {
            return;
        }
        if let (Some(r), Some(text)) = (self.running.as_mut(), self.platform.clipboard_get()) {
            let text = text.replace("\r\n", "\n");
            if !text.is_empty() {
                r.state
                    .egui_input_mut()
                    .events
                    .push(egui::Event::Paste(text));
            }
        }
    }
}

impl<F: Frame> ApplicationHandler<UserEvent> for Runner<F> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.running.is_some() {
            return;
        }
        match self.start(event_loop) {
            Ok(r) => self.running = Some(r),
            Err(e) => {
                self.error = Some(e);
                event_loop.exit();
                return;
            }
        }
        // A hidden window gets no redraw request on every platform: paint the first frame now
        // (it shows the window).
        self.paint();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match &event {
            WindowEvent::CloseRequested | WindowEvent::Destroyed => {
                event_loop.exit();
                return;
            }
            WindowEvent::RedrawRequested => {
                self.paint();
                if self.close {
                    event_loop.exit();
                }
                return;
            }
            WindowEvent::Resized(size) => {
                if let (Some(r), Some(w), Some(h)) = (
                    self.running.as_mut(),
                    NonZeroU32::new(size.width),
                    NonZeroU32::new(size.height),
                ) {
                    r.painter.on_window_resized(ViewportId::ROOT, w, h);
                }
            }
            WindowEvent::ModifiersChanged(m) => self.modifiers = m.state(),
            _ => {}
        }
        let Some(r) = self.running.as_mut() else {
            return;
        };
        let response = r.state.on_window_event(&r.window, &event);
        if let WindowEvent::KeyboardInput { event: key, .. } = &event {
            self.paste_shortcut(key);
        }
        if response.repaint
            && let Some(r) = self.running.as_ref()
        {
            r.window.request_redraw();
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        let UserEvent::Repaint(delay) = event;
        if delay.is_zero() {
            if let Some(r) = self.running.as_ref() {
                r.window.request_redraw();
            }
            return;
        }
        if let Some(at) = Instant::now().checked_add(delay)
            && self
                .repaint_at
                .is_none_or(|old| at < old || old <= Instant::now())
        {
            self.repaint_at = Some(at);
            event_loop.set_control_flow(ControlFlow::WaitUntil(at));
        }
    }

    fn new_events(&mut self, event_loop: &ActiveEventLoop, cause: winit::event::StartCause) {
        if let winit::event::StartCause::ResumeTimeReached { .. } = cause {
            self.repaint_at = None;
            event_loop.set_control_flow(ControlFlow::Wait);
            if let Some(r) = self.running.as_ref() {
                r.window.request_redraw();
            }
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(r) = self.running.as_mut() {
            r.painter.destroy();
        }
    }
}

/// Runs the window until it is closed. Errors are the plain reason the window could not open.
pub fn run(
    options: WindowOptions,
    platform: Arc<dyn Platform>,
    frame: impl Frame,
) -> Result<(), String> {
    let event_loop = EventLoop::<UserEvent>::with_user_event()
        .build()
        .map_err(|e| format!("cannot start the window: {e}"))?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut runner = Runner {
        options,
        platform,
        frame,
        proxy: event_loop.create_proxy(),
        running: None,
        repaint_at: None,
        modifiers: ModifiersState::empty(),
        error: None,
        set_up: false,
        close: false,
    };
    event_loop
        .run_app(&mut runner)
        .map_err(|e| format!("the window stopped: {e}"))?;
    match runner.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
