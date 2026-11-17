//! The devcontainer subset Work Hub understands (D6, algorithm `workhub-devcontainer-subset`).
//!
//! `.devcontainer/devcontainer.json` is JSONC (comments and trailing commas allowed). Only these
//! keys are read, every other key is ignored:
//! - `image` — the sentinel [`DEFAULT_IMAGE_SENTINEL`] means Work Hub's default image;
//! - `build.dockerfile` with optional `build.context` (both relative to `.devcontainer/`,
//!   the context defaults to `"."`);
//! - `containerEnv` — a map of strings;
//! - `postCreateCommand` — a string (run by `sh -c`) or an argv array.

use std::collections::BTreeMap;

use jsonc_parser::ParseOptions;
use serde_json::{Map, Value};

/// The `image` value that means `WORK_HUB_DEFAULT_IMAGE`.
pub const DEFAULT_IMAGE_SENTINEL: &str = "artisyn-work-hub-default";

/// Where the container image of a definition comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageSource {
    /// Work Hub's default image (`WORK_HUB_DEFAULT_IMAGE`).
    Default,
    /// A named image that must already exist locally (no pull).
    Image(String),
    /// Built from a Dockerfile; both paths are relative to `.devcontainer/`.
    Build { dockerfile: String, context: String },
}

/// The parsed subset of a devcontainer definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerSpec {
    pub source: ImageSource,
    pub container_env: BTreeMap<String, String>,
    /// A string becomes `["sh", "-c", s]`; an empty string or array means none.
    pub post_create: Option<Vec<String>>,
}

/// Parses a devcontainer definition. The error is a plain-English sentence for the user.
pub fn parse(jsonc: &str) -> Result<ContainerSpec, String> {
    let options = ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
        allow_bare_decimal_point_numbers: false,
        allow_non_finite_numbers: false,
        allow_extended_string_escapes: false,
    };
    let value: Value = jsonc_parser::parse_to_serde_value(jsonc, &options)
        .map_err(|e| format!("devcontainer.json is not valid JSON: {e}"))?;
    let Value::Object(root) = value else {
        return Err("devcontainer.json must contain a JSON object.".to_string());
    };

    Ok(ContainerSpec {
        source: parse_source(&root)?,
        container_env: parse_env(root.get("containerEnv"))?,
        post_create: parse_post_create(root.get("postCreateCommand"))?,
    })
}

fn parse_source(root: &Map<String, Value>) -> Result<ImageSource, String> {
    let image = match root.get("image") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(_) => return Err("devcontainer.json: \"image\" must be a non-empty string.".into()),
    };
    let build = match root.get("build") {
        None | Some(Value::Null) => None,
        Some(Value::Object(b)) => Some(parse_build(b)?),
        Some(_) => return Err("devcontainer.json: \"build\" must be an object.".into()),
    };
    match (image, build) {
        (Some(_), Some(_)) => {
            Err("devcontainer.json: use either \"image\" or \"build\", not both.".into())
        }
        (Some(image), None) if image == DEFAULT_IMAGE_SENTINEL => Ok(ImageSource::Default),
        (Some(image), None) => Ok(ImageSource::Image(image)),
        (None, Some(build)) => Ok(build),
        (None, None) => {
            Err("devcontainer.json needs an \"image\" or a \"build.dockerfile\".".into())
        }
    }
}

fn parse_build(build: &Map<String, Value>) -> Result<ImageSource, String> {
    let dockerfile = match build.get("dockerfile") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => {
            return Err(
                "devcontainer.json: \"build.dockerfile\" must be a non-empty string.".into(),
            );
        }
    };
    let context = match build.get("context") {
        None | Some(Value::Null) => ".".to_string(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(_) => {
            return Err("devcontainer.json: \"build.context\" must be a non-empty string.".into());
        }
    };
    Ok(ImageSource::Build {
        dockerfile,
        context,
    })
}

fn parse_env(value: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    match value {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (key, v) in map {
                let Value::String(s) = v else {
                    return Err(format!(
                        "devcontainer.json: \"containerEnv.{key}\" must be a string."
                    ));
                };
                if key.is_empty() || key.contains('=') || key.contains('\0') || s.contains('\0') {
                    return Err(format!(
                        "devcontainer.json: \"containerEnv\" has an invalid variable \"{key}\"."
                    ));
                }
                env.insert(key.clone(), s.clone());
            }
        }
        Some(_) => {
            return Err("devcontainer.json: \"containerEnv\" must be an object of strings.".into());
        }
    }
    Ok(env)
}

fn parse_post_create(value: Option<&Value>) -> Result<Option<Vec<String>>, String> {
    const MSG: &str =
        "devcontainer.json: \"postCreateCommand\" must be a string or an array of strings.";
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(vec!["sh".into(), "-c".into(), s.clone()])),
        Some(Value::Array(items)) => {
            let argv = items
                .iter()
                .map(|v| match v {
                    Value::String(s) => Ok(s.clone()),
                    _ => Err(MSG.to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(if argv.is_empty() { None } else { Some(argv) })
        }
        Some(_) => Err(MSG.into()),
    }
}
