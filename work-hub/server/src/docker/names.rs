//! Docker object names and labels (D5).
//!
//! | Object | Name |
//! |---|---|
//! | workspace container | `wh-ws-<workspace uuid>` |
//! | workspace volumes | `wh-ws-<uuid>-repo`, `wh-ws-<uuid>-home` |
//! | workstream container | `wh-st-<workstream uuid>` |
//! | workstream volumes | `wh-st-<uuid>-repo`, `wh-st-<uuid>-home` |
//! | built devcontainer image | `wh-img-<workspace uuid>:1` |
//! | checkpoint image | `wh-ckpt-<workspace uuid>:<seq>` |
//! | helper container | `wh-helper-<random uuid>` |

use std::collections::HashMap;

use uuid::Uuid;

/// Every Work Hub object carries `artisyn.workhub=1`.
pub const LABEL_ROOT: &str = "artisyn.workhub";
/// `WORK_HUB_INSTANCE`: scopes every object to one Work Hub installation.
pub const LABEL_INSTANCE: &str = "artisyn.workhub.instance";
pub const LABEL_WORKSPACE: &str = "artisyn.workhub.workspace";
pub const LABEL_WORKSTREAM: &str = "artisyn.workhub.workstream";
pub const LABEL_ROLE: &str = "artisyn.workhub.role";

/// Mount point of the repo volume in every container.
pub const REPO_MOUNT: &str = "/workspace";
/// The working-branch checkout inside the workspace container's repo volume.
pub const WORKSPACE_REPO_DIR: &str = "/workspace/repo";
/// A workstream's worktree inside its own container.
pub const WORKSTREAM_WORKTREE_DIR: &str = "/workspace/worktree";

/// Tag of the built devcontainer image (`wh-img-<uuid>:1`).
pub const BUILT_IMAGE_TAG: &str = "1";

/// `artisyn.workhub.role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Workspace,
    Workstream,
    Helper,
    Checkpoint,
    Built,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Workspace => "workspace",
            Role::Workstream => "workstream",
            Role::Helper => "helper",
            Role::Checkpoint => "checkpoint",
            Role::Built => "built",
        }
    }
}

/// `wh-ws-<uuid>`.
pub fn workspace_container(workspace: Uuid) -> String {
    format!("wh-ws-{workspace}")
}

/// `wh-ws-<uuid>-repo`.
pub fn workspace_repo_volume(workspace: Uuid) -> String {
    format!("wh-ws-{workspace}-repo")
}

/// `wh-ws-<uuid>-home`.
pub fn workspace_home_volume(workspace: Uuid) -> String {
    format!("wh-ws-{workspace}-home")
}

/// `wh-st-<uuid>`.
pub fn workstream_container(workstream: Uuid) -> String {
    format!("wh-st-{workstream}")
}

/// `wh-st-<uuid>-repo`.
pub fn workstream_repo_volume(workstream: Uuid) -> String {
    format!("wh-st-{workstream}-repo")
}

/// `wh-st-<uuid>-home`.
pub fn workstream_home_volume(workstream: Uuid) -> String {
    format!("wh-st-{workstream}-home")
}

/// Repository of the built devcontainer image, `wh-img-<uuid>`.
pub fn built_image_repo(workspace: Uuid) -> String {
    format!("wh-img-{workspace}")
}

/// `wh-img-<uuid>:1`.
pub fn built_image(workspace: Uuid) -> String {
    format!("{}:{BUILT_IMAGE_TAG}", built_image_repo(workspace))
}

/// Repository of the checkpoint images, `wh-ckpt-<uuid>`.
pub fn checkpoint_repo(workspace: Uuid) -> String {
    format!("wh-ckpt-{workspace}")
}

/// `wh-ckpt-<uuid>:<seq>`.
pub fn checkpoint_image(workspace: Uuid, seq: i32) -> String {
    format!("{}:{seq}", checkpoint_repo(workspace))
}

/// `wh-helper-<random uuid>`.
pub fn helper_container() -> String {
    format!("wh-helper-{}", Uuid::new_v4())
}

/// Builds the label set of one object.
#[derive(Debug, Clone)]
pub struct Labels {
    map: HashMap<String, String>,
}

impl Labels {
    /// `artisyn.workhub=1`, the instance and the role.
    pub fn new(instance: &str, role: Role) -> Self {
        let mut map = HashMap::new();
        map.insert(LABEL_ROOT.to_string(), "1".to_string());
        map.insert(LABEL_INSTANCE.to_string(), instance.to_string());
        map.insert(LABEL_ROLE.to_string(), role.as_str().to_string());
        Labels { map }
    }

    pub fn workspace(mut self, workspace: Uuid) -> Self {
        self.map
            .insert(LABEL_WORKSPACE.to_string(), workspace.to_string());
        self
    }

    pub fn workstream(mut self, workstream: Uuid) -> Self {
        self.map
            .insert(LABEL_WORKSTREAM.to_string(), workstream.to_string());
        self
    }

    pub fn into_map(self) -> HashMap<String, String> {
        self.map
    }

    pub fn as_map(&self) -> &HashMap<String, String> {
        &self.map
    }
}

/// An Engine list filter `{"label": [...]}` matching every object of this instance, narrowed by
/// `extra` `key=value` labels (all must match).
pub fn label_filter(instance: &str, extra: &[(&str, String)]) -> HashMap<String, Vec<String>> {
    let mut labels = vec![
        format!("{LABEL_ROOT}=1"),
        format!("{LABEL_INSTANCE}={instance}"),
    ];
    labels.extend(extra.iter().map(|(k, v)| format!("{k}={v}")));
    HashMap::from([("label".to_string(), labels)])
}

/// The filter of every object of this instance.
pub fn instance_filter(instance: &str) -> HashMap<String, Vec<String>> {
    label_filter(instance, &[])
}

/// The filter of every object of one workspace (its workstreams' objects included).
pub fn workspace_filter(instance: &str, workspace: Uuid) -> HashMap<String, Vec<String>> {
    label_filter(instance, &[(LABEL_WORKSPACE, workspace.to_string())])
}

/// The filter of every object of one workstream.
pub fn workstream_filter(instance: &str, workstream: Uuid) -> HashMap<String, Vec<String>> {
    label_filter(instance, &[(LABEL_WORKSTREAM, workstream.to_string())])
}
