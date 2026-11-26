//! Picks the `AgentBook.exe` the installer embeds.
//!
//! `npm run build` (scripts/build.mjs) builds `AgentBook.exe` first and then this crate with
//! `AGENTBOOK_EMBED_EXE` set to that file. Any other build of this crate (clippy, a plain
//! `cargo build --workspace`) embeds an empty payload, and such a setup only says that it was
//! built without AgentBook.exe.

//!
//! It also links the AgentBook icon into `AgentBook-Setup.exe` (the app's `icon.rs`).

use std::path::PathBuf;

include!("../app/icon.rs");

const VAR: &str = "AGENTBOOK_EMBED_EXE";

fn main() {
    let dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("dir"));
    println!("cargo:rerun-if-changed=../app/icon.rs");
    link_exe_icon(&dir.join("../app/images"), "AgentBook-Setup");
    println!("cargo:rerun-if-env-changed={VAR}");
    let payload = match std::env::var_os(VAR).filter(|v| !v.is_empty()) {
        Some(path) => {
            let path = PathBuf::from(path);
            let meta = std::fs::metadata(&path)
                .unwrap_or_else(|e| panic!("{VAR}={}: {e}", path.display()));
            assert!(
                meta.is_file() && meta.len() > 0,
                "{VAR}={} is not a non-empty file",
                path.display()
            );
            println!("cargo:rerun-if-changed={}", path.display());
            path
        }
        None => {
            let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
            let empty = out.join("no-agentbook-exe.bin");
            std::fs::write(&empty, []).expect("write the empty payload");
            empty
        }
    };
    println!(
        "cargo:rustc-env=AGENTBOOK_SETUP_PAYLOAD={}",
        payload.display()
    );
}
