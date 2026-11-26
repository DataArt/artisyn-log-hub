//! A running action's progress and log: steps, a log file under `logs/` and the tail kept in the
//! snapshot (shown with Copy log and Retry after a failure). Logs carry build and tool output only,
//! never variable values.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::engine::Ctx;
use crate::snapshot::{ActionState, ActionView};

/// Log lines kept in the snapshot.
pub const LOG_TAIL_LINES: usize = 40;
/// Finished actions kept in the snapshot.
const KEEP_FINISHED: usize = 50;

#[derive(Clone)]
pub(crate) struct Action {
    ctx: Arc<Ctx>,
    pub id: u64,
    file: Arc<Mutex<Option<std::fs::File>>>,
}

impl Action {
    pub fn start(
        ctx: &Arc<Ctx>,
        id: u64,
        kind: &str,
        laptop: Option<&str>,
        folder: Option<&str>,
    ) -> Self {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let subject = laptop.or(folder).unwrap_or("agentbook");
        let logs = ctx.layout.logs_dir();
        let path = logs.join(format!("{secs}-{id}-{kind}-{subject}.log"));
        let file = std::fs::create_dir_all(&logs)
            .and_then(|()| std::fs::File::create(&path))
            .ok();
        let view = ActionView {
            id,
            kind: kind.to_string(),
            laptop: laptop.map(str::to_string),
            folder: folder.map(str::to_string),
            step: String::new(),
            step_index: 0,
            steps_total: 0,
            state: ActionState::Running,
            log_tail: Vec::new(),
            log_file: file.as_ref().map(|_| path.clone()),
        };
        ctx.update_snapshot(|s| {
            s.actions.push(view);
            let finished = s.actions.iter().filter(|a| a.finished()).count();
            if finished > KEEP_FINISHED {
                let mut drop = finished - KEEP_FINISHED;
                s.actions.retain(|a| {
                    if drop > 0 && a.finished() {
                        drop -= 1;
                        false
                    } else {
                        true
                    }
                });
            }
        });
        Self {
            ctx: ctx.clone(),
            id,
            file: Arc::new(Mutex::new(file)),
        }
    }

    fn with_view(&self, f: impl FnOnce(&mut ActionView)) {
        let id = self.id;
        self.ctx.update_snapshot(|s| {
            if let Some(a) = s.actions.iter_mut().find(|a| a.id == id) {
                f(a);
            }
        });
    }

    /// Points the action at a folder (e.g. Add folder found the folder already on the list).
    pub fn set_folder(&self, folder: &str) {
        self.with_view(|a| a.folder = Some(folder.to_string()));
    }

    /// Moves to step `index` of `total`, logging it.
    pub fn step(&self, index: u32, total: u32, text: &str) {
        self.line(&format!("== {text}"));
        self.with_view(|a| {
            a.step = text.to_string();
            a.step_index = index;
            a.steps_total = total;
        });
    }

    /// Appends one log line.
    pub fn line(&self, line: &str) {
        let line = line.trim_end();
        if let Ok(mut guard) = self.file.lock()
            && let Some(f) = guard.as_mut()
        {
            let _ = writeln!(f, "{line}");
        }
        if line.trim().is_empty() {
            return;
        }
        self.with_view(|a| {
            a.log_tail.push(line.to_string());
            if a.log_tail.len() > LOG_TAIL_LINES {
                let drop = a.log_tail.len() - LOG_TAIL_LINES;
                a.log_tail.drain(..drop);
            }
        });
    }

    pub fn done(&self) {
        self.line("== done");
        self.with_view(|a| a.state = ActionState::Done);
    }

    pub fn fail(&self, message: &str) {
        self.line(&format!("== failed: {message}"));
        self.with_view(|a| {
            a.state = ActionState::Failed {
                message: message.to_string(),
            }
        });
    }
}
