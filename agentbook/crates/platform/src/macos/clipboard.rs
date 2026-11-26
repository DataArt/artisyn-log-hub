//! The macOS clipboard (plain text) through `/usr/bin/pbcopy` and `/usr/bin/pbpaste`: Copy log,
//! and copy and paste in the UI's text fields. `LANG` is set to a UTF-8 locale because an app
//! started from the Finder has none, and both tools then fall back to a legacy encoding.

use std::io::Write;
use std::process::{Command, Stdio};

use crate::PlatformError;

fn tool(name: &str) -> Command {
    let mut cmd = Command::new(format!("/usr/bin/{name}"));
    cmd.env("LANG", "en_US.UTF-8").env("LC_CTYPE", "UTF-8");
    cmd
}

pub fn set_text(text: &str) -> Result<(), PlatformError> {
    let mut child = tool("pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| PlatformError::Other(format!("could not start pbcopy: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| PlatformError::Other(format!("pbcopy: {e}")))?;
    }
    let status = child
        .wait()
        .map_err(|e| PlatformError::Other(format!("pbcopy: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(PlatformError::Command {
            program: "pbcopy".into(),
            status: status.to_string(),
            output: String::new(),
        })
    }
}

pub fn get_text() -> Option<String> {
    let output = tool("pbpaste")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    (!text.is_empty()).then_some(text)
}
