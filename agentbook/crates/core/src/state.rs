//! The per-user `state.json` and the per-folder in-container state files.
//!
//! Format rules (External surface, "Per-user data folder"):
//! - additive-only: every object keeps the fields this version does not know (`extra`) and writes
//!   them back unchanged, so a newer tool's fields survive an older copy writing the file;
//! - a `schema_version` newer than [`STATE_SCHEMA_VERSION`] loads read-only ([`LoadedState::read_only`])
//!   and [`write_state`] refuses it;
//! - a Hidden variable value has no payload: [`VarValue::Hidden`] is only a marker, the value
//!   itself lives in the OS credential store and can never be written here.
//!
//! Algorithm doc: `docs/knowledgebase/algorithms/agentbook-state-file.md`.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

/// The `schema_version` this tool writes and fully understands.
pub const STATE_SCHEMA_VERSION: u64 = 1;

/// The schema version of the in-container state files (`folder.json`, `laptops/<id>.json`).
pub const CONTAINER_STATE_SCHEMA_VERSION: u64 = 1;

/// Characters of a laptop or folder id: RFC 4648 base32, lowercase.
const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Length of a laptop or folder id (5 random bytes = 40 bits = 8 base32 characters).
pub const ID_LEN: usize = 8;

/// The whole `state.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub schema_version: u64,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub laptops: Vec<Laptop>,
    /// Recently chosen shared-folder paths, most recent first.
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            folders: Vec::new(),
            laptops: Vec::new(),
            recent: Vec::new(),
            extra: Map::new(),
        }
    }
}

/// A shared folder the user added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    /// Host path of the shared folder, as the user chose it.
    pub path: String,
    /// Claude's start folder relative to `path` (`/`-separated, `""` = the folder root), once
    /// decided (`agentbook-claude-dir`); absent until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_dir: Option<String>,
    pub equipment: EquipmentRef,
    /// Folder-wide variable settings.
    #[serde(default)]
    pub vars: Vec<VarSetting>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Which Equipment a folder's laptops use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EquipmentRef {
    pub kind: EquipmentKind,
    /// The selected devcontainer config, relative to the shared folder (`/`-separated), for
    /// [`EquipmentKind::Project`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl EquipmentRef {
    pub fn standard() -> Self {
        Self {
            kind: EquipmentKind::Standard,
            config: None,
            extra: Map::new(),
        }
    }

    pub fn project(config: impl Into<String>) -> Self {
        Self {
            kind: EquipmentKind::Project,
            config: Some(config.into()),
            extra: Map::new(),
        }
    }
}

/// A string-valued enum that keeps a value written by a newer tool (`Other`) as-is.
macro_rules! open_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $name {
            $($(#[$vmeta])* $variant,)+
            /// A value written by a newer tool; kept and written back unchanged.
            Other(String),
        }

        impl $name {
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $text,)+
                    Self::Other(s) => s,
                }
            }

            pub fn parse(s: &str) -> Self {
                match s {
                    $($text => Self::$variant,)+
                    other => Self::Other(other.to_string()),
                }
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                Ok(Self::parse(&String::deserialize(d)?))
            }
        }
    };
}

open_enum!(
    /// Standard Equipment (embedded Dockerfile) or the project's devcontainer.
    EquipmentKind { Standard => "standard", Project => "project" }
);

open_enum!(
    /// Where a stored variable setting comes from.
    VarOrigin {
        /// Overrides a project default (`containerEnv` / `remoteEnv`) of the same name.
        Override => "override",
        /// A variable the devcontainer does not declare.
        Added => "added",
    }
);

open_enum!(
    /// The libc family of a laptop's layered image.
    Libc { Glibc => "glibc", Musl => "musl" }
);

/// One variable setting (folder-wide or "Only for one laptop").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VarSetting {
    pub name: String,
    pub value: VarValue,
    pub origin: VarOrigin,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A stored variable value. `Hidden` carries nothing: the value is in the OS credential store
/// under `credential_target` (see `variables`), so it cannot be written to `state.json`.
///
/// JSON: `{"kind":"plain","text":"…"}` or `{"kind":"hidden"}`. A `hidden` object is read
/// without any other key, so a stray `text` next to it is dropped on the next write. A kind
/// written by a newer tool is kept whole as `Other` and written back unchanged; this version
/// does not deliver it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarValue {
    Plain(String),
    Hidden,
    /// A value kind written by a newer tool (the whole object, `kind` included).
    Other(Map<String, Value>),
}

impl Serialize for VarValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut obj = Map::new();
        match self {
            Self::Plain(text) => {
                obj.insert("kind".into(), Value::from("plain"));
                obj.insert("text".into(), Value::from(text.as_str()));
            }
            Self::Hidden => {
                obj.insert("kind".into(), Value::from("hidden"));
            }
            Self::Other(raw) => obj.clone_from(raw),
        }
        obj.serialize(s)
    }
}

impl<'de> Deserialize<'de> for VarValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let obj = Map::<String, Value>::deserialize(d)?;
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| D::Error::custom("a variable value needs a string \"kind\""))?;
        match kind {
            "plain" => match obj.get("text") {
                Some(Value::String(text)) => Ok(Self::Plain(text.clone())),
                _ => Err(D::Error::custom(
                    "a plain variable value needs a string \"text\"",
                )),
            },
            "hidden" => Ok(Self::Hidden),
            _ => Ok(Self::Other(obj)),
        }
    }
}

/// A laptop (slot).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Laptop {
    pub id: String,
    pub folder_id: String,
    /// Display name only; never used in the alias or Docker names.
    pub name: String,
    /// Host loopback port published to the container's port 22.
    pub port: u16,
    #[serde(default)]
    pub given: Vec<Given>,
    /// Equipment config hash of the image the laptop runs (`agentbook-equipment`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equipment_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub libc: Option<Libc>,
    /// Container generation, `artisyn.agentbook.gen`.
    #[serde(default, rename = "gen")]
    pub generation: u64,
    /// "Only for one laptop" variable settings.
    #[serde(default)]
    pub laptop_vars: Vec<VarSetting>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A given (extra host) folder of a laptop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Given {
    /// Host path.
    pub path: String,
    /// "View only".
    #[serde(default)]
    pub read_only: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `state.json` as loaded.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedState {
    pub state: State,
    /// The file was written by a newer tool (`schema_version` > [`STATE_SCHEMA_VERSION`]): show
    /// it, but never write it back ("update AgentBook").
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    /// Not JSON, not an object, no valid `schema_version`, or a known field of the wrong shape.
    Invalid(String),
    /// [`write_state`] on a read-only state.
    ReadOnly,
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "state.json is not valid: {msg}"),
            Self::ReadOnly => f.write_str(
                "state.json was written by a newer AgentBook; update AgentBook to change it",
            ),
        }
    }
}

impl std::error::Error for StateError {}

/// Parses `state.json`.
pub fn parse_state(text: &str) -> Result<LoadedState, StateError> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| StateError::Invalid(e.to_string()))?;
    let Value::Object(obj) = &value else {
        return Err(StateError::Invalid(
            "the top level must be an object".into(),
        ));
    };
    let version = match obj.get("schema_version").and_then(Value::as_u64) {
        Some(v) if v >= 1 => v,
        _ => {
            return Err(StateError::Invalid(
                "schema_version must be a whole number of at least 1".into(),
            ));
        }
    };
    let state: State =
        serde_json::from_value(value).map_err(|e| StateError::Invalid(e.to_string()))?;
    Ok(LoadedState {
        state,
        read_only: version > STATE_SCHEMA_VERSION,
    })
}

/// Renders a state for writing (pretty JSON with a final newline).
pub fn render_state(state: &State) -> String {
    let mut text = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

/// Renders a loaded state for writing back; refuses one loaded read-only.
pub fn write_state(loaded: &LoadedState) -> Result<String, StateError> {
    if loaded.read_only {
        return Err(StateError::ReadOnly);
    }
    Ok(render_state(&loaded.state))
}

/// A new id (laptop or folder) from 5 random bytes: 8 lowercase base32 characters. The caller
/// supplies the randomness, so this stays pure.
pub fn id_from_bytes(bytes: [u8; 5]) -> String {
    let bits = bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
    (0..ID_LEN)
        .map(|i| {
            let shift = 5 * (ID_LEN - 1 - i);
            let index = usize::try_from((bits >> shift) & 31).unwrap_or(0);
            char::from(BASE32_ALPHABET[index])
        })
        .collect()
}

/// Whether `id` has the shape of an id (8 lowercase base32 characters).
pub fn is_valid_id(id: &str) -> bool {
    id.len() == ID_LEN && id.bytes().all(|b| BASE32_ALPHABET.contains(&b))
}

/// `/opt/agentbook/state/folder.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FolderInfo {
    pub schema_version: u64,
    /// The shared folder's display name.
    pub name: String,
    pub shared_path_in_container: String,
    pub host_path: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `/opt/agentbook/state/laptops/<id>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaptopInfo {
    pub schema_version: u64,
    pub id: String,
    pub name: String,
    /// `working` or `sleeping`.
    pub state: String,
    #[serde(default)]
    pub given: Vec<GivenInfo>,
    /// Variable names only, never values.
    #[serde(default)]
    pub vars: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A given folder as `ws mounts` shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GivenInfo {
    pub container: String,
    pub host: String,
    /// `read-write` or `view-only`.
    pub mode: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
