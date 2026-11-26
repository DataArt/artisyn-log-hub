//! AgentBook desktop app (`AgentBook.exe`).
// A GUI program: no console window in release builds (debug builds keep it for messages).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    match agentbook_app::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("AgentBook: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
