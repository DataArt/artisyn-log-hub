//! Links the exe icon into `AgentBook.exe` (see `icon.rs`).

include!("icon.rs");

fn main() {
    let dir = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("dir"));
    println!("cargo:rerun-if-changed=icon.rs");
    link_exe_icon(&dir.join("images"), "AgentBook");
}
