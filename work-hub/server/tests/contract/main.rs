//! Work Hub API contract tests (D13): `npm run test:contract` from `work-hub/`
//! (`scripts/contract.mjs`, which builds the images and runs
//! `cargo test --test contract -- --test-threads=1`).
//!
//! Needs Postgres (`WORK_HUB_TEST_DATABASE_URL`), Docker and the fake-agent image. The stand and
//! the runner are in [`harness`]; the route registry and its generic checks in [`registry`].

mod auth;
mod fs;
mod harness;
mod registry;
mod workspaces;
mod workstreams;

use std::process::ExitCode;

fn main() -> ExitCode {
    // Order: no Docker objects first, then the families that build on user A's world, the
    // ownership sweep last (it sees every route with real ids).
    let mut cases = Vec::new();
    cases.extend(
        registry::cases()
            .into_iter()
            .filter(|c| c.name == "registry::meta"),
    );
    cases.extend(auth::cases());
    cases.extend(
        registry::cases()
            .into_iter()
            .filter(|c| c.name == "registry::session_rows_401_without_cookie"),
    );
    cases.extend(workspaces::cases());
    cases.extend(fs::cases());
    cases.extend(workstreams::cases());
    cases.extend(
        registry::cases()
            .into_iter()
            .filter(|c| c.name == "registry::owner_scoped_rows_404_for_other_user"),
    );
    harness::run_cases(cases)
}
