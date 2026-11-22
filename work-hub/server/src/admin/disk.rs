//! Disk usage of the instance's Docker objects for the admin overview (plan D15). Every measure
//! answers `None` when Docker cannot be asked (unreachable, timed out, an answer without the
//! data); the overview then shows the size as unknown instead of failing.

use std::collections::HashMap;
use std::time::Duration;

use bollard::query_parameters::{DataUsageOptionsBuilder, ListContainersOptionsBuilder};
use serde_json::Value;

use crate::docker::{Docker, names};

/// Longest wait for one Docker answer: `system df` walks the volumes, which can take a while.
const MEASURE_TIMEOUT: Duration = Duration::from_secs(90);

/// Bytes per workspace id (the `artisyn.workhub.workspace` label).
pub type PerWorkspace = HashMap<String, u64>;

/// Sizes from `GET /system/df`: per-workspace volumes and images, and the git cache volume.
#[derive(Debug, Clone, Default)]
pub struct DfSizes {
    pub volumes: Option<PerWorkspace>,
    pub images: Option<PerWorkspace>,
    pub git_cache: Option<u64>,
}

/// The writable layers (`SizeRw`) of the instance's containers, summed per workspace label.
pub async fn containers(docker: &Docker, instance: &str) -> Option<PerWorkspace> {
    let filter = names::instance_filter(instance);
    let options = ListContainersOptionsBuilder::default()
        .all(true)
        .size(true)
        .filters(&filter)
        .build();
    let docker = docker.clone().with_timeout(MEASURE_TIMEOUT);
    let list =
        match tokio::time::timeout(MEASURE_TIMEOUT, docker.list_containers(Some(options))).await {
            Ok(Ok(list)) => list,
            Ok(Err(e)) => {
                tracing::warn!("admin overview: container sizes unavailable: {e}");
                return None;
            }
            Err(_) => {
                tracing::warn!("admin overview: container sizes timed out");
                return None;
            }
        };
    let mut out = PerWorkspace::new();
    for c in list {
        let Some(ws) = c
            .labels
            .as_ref()
            .and_then(|l| l.get(names::LABEL_WORKSPACE))
            .cloned()
        else {
            continue;
        };
        let size = c.size_rw.unwrap_or(0).max(0) as u64;
        *out.entry(ws).or_insert(0) += size;
    }
    Some(out)
}

/// `GET /system/df` (volumes and images, verbose): `UsageData.Size` of the instance's volumes
/// and the unique size of its images (`Size` − `SharedSize`, so the base image layers every
/// checkpoint shares are not counted once per workspace), summed per workspace label; the git
/// cache volume `wh-gitcache-<instance>` separately. A size the Engine reports as `-1` (not
/// computed, e.g. a bind-mounted volume whose data is the workspace's file-area folder, which
/// the overview already counts as files) counts as 0.
pub async fn system_df(docker: &Docker, instance: &str) -> DfSizes {
    // No `type` filter: bollard cannot URL-encode that list parameter ("unsupported value").
    let options = DataUsageOptionsBuilder::default().verbose(true).build();
    let docker = docker.clone().with_timeout(MEASURE_TIMEOUT);
    let resp = match tokio::time::timeout(MEASURE_TIMEOUT, docker.df(Some(options))).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            tracing::warn!("admin overview: docker system df failed: {e}");
            return DfSizes::default();
        }
        Err(_) => {
            tracing::warn!("admin overview: docker system df timed out");
            return DfSizes::default();
        }
    };
    let git_cache_name = names::git_cache_volume(instance);
    let mut out = DfSizes::default();

    if let Some(items) = resp.volume_usage.and_then(|v| v.items) {
        let mut per_ws = PerWorkspace::new();
        let mut git_cache = None;
        for v in &items {
            if !is_ours(v, instance) {
                continue;
            }
            let size = non_negative(v.pointer("/UsageData/Size"));
            if v.get("Name").and_then(Value::as_str) == Some(git_cache_name.as_str()) {
                git_cache = Some(size);
            } else if let Some(ws) = workspace_label(v) {
                *per_ws.entry(ws).or_insert(0) += size;
            }
        }
        out.volumes = Some(per_ws);
        // Not created yet (the sidecar never started) = nothing on disk.
        out.git_cache = Some(git_cache.unwrap_or(0));
    }

    if let Some(items) = resp.image_usage.and_then(|i| i.items) {
        let mut per_ws = PerWorkspace::new();
        for img in &items {
            if !is_ours(img, instance) {
                continue;
            }
            let Some(ws) = workspace_label(img) else {
                continue;
            };
            let size = non_negative(img.get("Size"));
            let shared = img.get("SharedSize").and_then(Value::as_i64).unwrap_or(-1);
            let unique = if shared >= 0 {
                size.saturating_sub(shared as u64)
            } else {
                size
            };
            *per_ws.entry(ws).or_insert(0) += unique;
        }
        out.images = Some(per_ws);
    }
    out
}

fn labels(v: &Value) -> Option<&serde_json::Map<String, Value>> {
    v.get("Labels").and_then(Value::as_object)
}

/// Labelled with this instance (`artisyn.workhub.instance`).
fn is_ours(v: &Value, instance: &str) -> bool {
    labels(v)
        .and_then(|l| l.get(names::LABEL_INSTANCE))
        .and_then(Value::as_str)
        == Some(instance)
}

fn workspace_label(v: &Value) -> Option<String> {
    labels(v)
        .and_then(|l| l.get(names::LABEL_WORKSPACE))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn non_negative(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_i64).unwrap_or(0).max(0) as u64
}
