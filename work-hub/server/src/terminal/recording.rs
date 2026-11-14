//! Chat recordings (D11 "Recording", D17). `tmux pipe-pane` appends the raw output of `chat` to
//! `<home>/.workhub/term/chat.raw` inside the workstream container; [`sync`] copies the new bytes
//! (`tail -c +<synced_bytes+1>`) into `<DATA_DIR>/recordings/<file_name>` and advances
//! `terminal_recordings.synced_bytes`. A sync runs on attach, on detach, every
//! [`RECORDING_SYNC_INTERVAL`] for running open workstreams and before a stop or remove.
//! Every resize is stored with the log's byte offset at that moment (`terminal_resizes`).

use std::path::PathBuf;

use futures_util::StreamExt;
use serde::Serialize;
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::docker::exec::{self, EXEC_TIMEOUT_STATUS, sh};
use crate::docker::{DockerError, containers, names};
use crate::error::ApiError;
use crate::state::AppState;
use crate::terminal::tmux::shell_quote;
use crate::timing::RECORDING_SYNC_INTERVAL;

/// The chat log inside the container, relative to the container user's home.
pub const CHAT_LOG_REL: &str = ".workhub/term/chat.raw";

/// `<home>/.workhub/term/chat.raw`.
pub fn chat_log_path(home: &str) -> String {
    format!("{}/{CHAT_LOG_REL}", home.trim_end_matches('/'))
}

/// `<workstream uuid>.raw`, the file name stored in `terminal_recordings.file_name`.
pub fn file_name_for(workstream: Uuid) -> String {
    format!("{workstream}.raw")
}

/// Where a workstream's chat log lives.
#[derive(Debug, Clone)]
pub struct RecordingSource {
    pub workstream_id: Uuid,
    /// `wh-st-<uuid>`.
    pub container: String,
    /// The workspace's container user.
    pub user: String,
    /// `<home>/.workhub/term/chat.raw`.
    pub log_path: String,
}

impl RecordingSource {
    pub fn new(workstream_id: Uuid, user: &str, home: &str) -> Self {
        RecordingSource {
            workstream_id,
            container: names::workstream_container(workstream_id),
            user: user.to_string(),
            log_path: chat_log_path(home),
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RecordingRow {
    file_name: String,
    synced_bytes: i64,
    initial_cols: i32,
    initial_rows: i32,
}

async fn get_row(db: &PgPool, workstream: Uuid) -> Result<Option<RecordingRow>, sqlx::Error> {
    sqlx::query_as::<_, RecordingRow>(
        "SELECT file_name, synced_bytes, initial_cols, initial_rows \
         FROM terminal_recordings WHERE workstream_id = $1",
    )
    .bind(workstream)
    .fetch_optional(db)
    .await
}

/// A file name we accept inside the recordings directory.
fn safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/// The local recording file of a workstream; `None` when it has no recording row.
pub async fn recording_file(st: &AppState, workstream: Uuid) -> Result<Option<PathBuf>, ApiError> {
    let Some(row) = get_row(&st.db, workstream).await? else {
        return Ok(None);
    };
    if !safe_file_name(&row.file_name) {
        return Err(ApiError::internal(format!(
            "recording of {workstream} has an unsafe file name {:?}",
            row.file_name
        )));
    }
    Ok(Some(st.config.recordings_dir().join(row.file_name)))
}

/// Copies the bytes the container log gained since the last sync into the local file and
/// advances `synced_bytes`. Returns how many bytes were copied. A workstream without a recording
/// row or a container without a log copies nothing. Concurrent syncs of one workstream are
/// serialised.
pub async fn sync(st: &AppState, src: &RecordingSource) -> Result<u64, ApiError> {
    let _guard = st
        .locks
        .lock(&format!("recording:{}", src.workstream_id))
        .await;
    let Some(row) = get_row(&st.db, src.workstream_id).await? else {
        return Ok(0);
    };
    if !safe_file_name(&row.file_name) {
        return Err(ApiError::internal(format!(
            "recording of {} has an unsafe file name {:?}",
            src.workstream_id, row.file_name
        )));
    }
    let dir = st.config.recordings_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::internal(format!("cannot create {}: {e}", dir.display())))?;
    let path = dir.join(&row.file_name);

    let from = row.synced_bytes.max(0) + 1;
    let script = format!(
        "test -f {log} || exit 0; exec tail -c +{from} {log}",
        log = shell_quote(&src.log_path)
    );
    let mut stream =
        exec::exec_stream_stdout(&st.docker, &src.container, &src.user, &sh(script)).await?;

    let mut file: Option<tokio::fs::File> = None;
    let mut copied: u64 = 0;
    let mut failure: Option<DockerError> = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) if bytes.is_empty() => {}
            Ok(bytes) => {
                if file.is_none() {
                    file = Some(
                        tokio::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                            .await
                            .map_err(|e| {
                                ApiError::internal(format!("cannot open {}: {e}", path.display()))
                            })?,
                    );
                }
                if let Some(f) = file.as_mut() {
                    f.write_all(&bytes).await.map_err(|e| {
                        ApiError::internal(format!("cannot write {}: {e}", path.display()))
                    })?;
                }
                copied += bytes.len() as u64;
            }
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    if let Some(mut f) = file {
        f.flush()
            .await
            .map_err(|e| ApiError::internal(format!("cannot write {}: {e}", path.display())))?;
    }
    // Whatever reached the file counts, even when the stream broke off.
    if copied > 0 {
        sqlx::query(
            "UPDATE terminal_recordings SET synced_bytes = synced_bytes + $2, updated_at = now() \
             WHERE workstream_id = $1",
        )
        .bind(src.workstream_id)
        .bind(copied as i64)
        .execute(&st.db)
        .await?;
    }
    match failure {
        Some(e) => Err(e.into()),
        None => Ok(copied),
    }
}

/// Like [`sync`], but only logs a failure (attach, detach and the periodic task).
pub async fn sync_logged(st: &AppState, src: &RecordingSource) {
    if let Err(e) = sync(st, src).await {
        tracing::warn!("recording sync of {} failed: {e}", src.workstream_id);
    }
}

/// Stores a resize at the log's current size (`stat -c %s`; a missing log is offset 0).
pub async fn record_resize(
    st: &AppState,
    src: &RecordingSource,
    cols: u16,
    rows: u16,
) -> Result<(), ApiError> {
    let script = format!(
        "stat -c %s {log} 2>/dev/null || echo 0",
        log = shell_quote(&src.log_path)
    );
    let out = exec::exec_capture(
        &st.docker,
        &src.container,
        &src.user,
        &sh(script),
        None,
        EXEC_TIMEOUT_STATUS,
    )
    .await?;
    let offset: i64 = out
        .stdout_str()
        .lines()
        .next()
        .and_then(|l| l.trim().parse().ok())
        .unwrap_or(0);
    sqlx::query(
        "INSERT INTO terminal_resizes (workstream_id, byte_offset, cols, rows) \
         SELECT $1, $2, $3, $4 WHERE EXISTS \
           (SELECT 1 FROM terminal_recordings WHERE workstream_id = $1)",
    )
    .bind(src.workstream_id)
    .bind(offset)
    .bind(i32::from(cols))
    .bind(i32::from(rows))
    .execute(&st.db)
    .await?;
    Ok(())
}

/// Terminal size.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct TermSize {
    pub cols: i32,
    pub rows: i32,
}

/// One resize of `GET …/recording/meta`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ResizeMeta {
    pub offset: i64,
    pub cols: i32,
    pub rows: i32,
}

/// `GET …/recording/meta`: `{totalBytes, initial:{cols, rows}, resizes:[{offset, cols, rows}]}`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMeta {
    pub total_bytes: i64,
    pub initial: TermSize,
    pub resizes: Vec<ResizeMeta>,
}

/// The replay metadata of a workstream's recording; `None` without a recording row. `totalBytes`
/// is the size of the local file (what `GET …/recording` returns); resizes are sorted by offset.
pub async fn read_meta(st: &AppState, workstream: Uuid) -> Result<Option<RecordingMeta>, ApiError> {
    let Some(row) = get_row(&st.db, workstream).await? else {
        return Ok(None);
    };
    let total_bytes = if safe_file_name(&row.file_name) {
        match tokio::fs::metadata(st.config.recordings_dir().join(&row.file_name)).await {
            Ok(m) => m.len() as i64,
            Err(_) => 0,
        }
    } else {
        0
    };
    let resizes: Vec<(i64, i32, i32)> = sqlx::query_as(
        "SELECT byte_offset, cols, rows FROM terminal_resizes \
         WHERE workstream_id = $1 ORDER BY byte_offset, id",
    )
    .bind(workstream)
    .fetch_all(&st.db)
    .await?;
    Ok(Some(RecordingMeta {
        total_bytes,
        initial: TermSize {
            cols: row.initial_cols,
            rows: row.initial_rows,
        },
        resizes: resizes
            .into_iter()
            .map(|(offset, cols, rows)| ResizeMeta { offset, cols, rows })
            .collect(),
    }))
}

/// Open workstreams with their container user and home (the periodic sync).
async fn open_sources(db: &PgPool) -> Result<Vec<RecordingSource>, sqlx::Error> {
    let rows: Vec<(Uuid, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT s.id, w.container_user, w.home_dir FROM workstreams s \
         JOIN workspaces w ON w.id = s.workspace_id \
         JOIN terminal_recordings r ON r.workstream_id = s.id \
         WHERE s.state = 'open'",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, user, home)| Some(RecordingSource::new(id, &user?, &home?)))
        .collect())
}

/// One round of the periodic sync: every open workstream whose container is running.
pub async fn sync_running_open(st: &AppState) {
    let sources = match open_sources(&st.db).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("recording sync: cannot list open workstreams: {e}");
            return;
        }
    };
    for src in sources {
        match containers::inspect(&st.docker, &src.container).await {
            Ok(Some(info)) if info.running => sync_logged(st, &src).await,
            Ok(_) => {}
            Err(e) => {
                tracing::debug!("recording sync: cannot inspect {}: {e}", src.container);
                if e.is_unavailable() {
                    return;
                }
            }
        }
    }
}

/// Starts the periodic sync task (every [`RECORDING_SYNC_INTERVAL`]).
pub fn spawn_periodic_sync(st: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECORDING_SYNC_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // the first tick fires at once; start after one interval
        loop {
            tick.tick().await;
            sync_running_open(&st).await;
        }
    });
}
