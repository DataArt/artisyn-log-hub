//! AgentBook scenario suite (`npm run test:scenarios` from `agentbook/`): drives the engine on real
//! Docker with a fake home, a local download server and a fake Desktop launcher, all under the
//! repo's `tmp/`. Built as the `scenarios` test target of `agentbook-engine` (harness = false).
//!
//! Steps run in order (later ones reuse what earlier ones set up); `--only ac17,ac6` picks some.
//! Whatever happens, the stand removes its own Docker objects, credentials and folder at the end.

mod ac17;
mod ac6;
mod given;
mod images;
mod laptops;
mod platform;
mod server;
mod stand;
mod variables;

use std::panic::AssertUnwindSafe;
use std::time::Instant;

use stand::{Stand, StepResult};

type Step = (&'static str, fn(&Stand) -> StepResult);

const STEPS: &[Step] = &[
    ("ac17", ac17::run),
    ("ac6", ac6::run),
    ("ac6-compose", ac6::run_compose),
    ("laptops", laptops::run),
    ("ports", laptops::run_ports),
    ("wsl-keep-alive", laptops::run_wsl_keep_alive),
    ("wsl-owner", laptops::run_wsl_owner),
    ("given", given::run),
    ("variables", variables::run),
    ("images", images::run),
    ("ac7a-scratch", images::run_scratch),
];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let only: Option<Vec<String>> = args
        .iter()
        .position(|a| a == "--only")
        .and_then(|i| args.get(i + 1))
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .collect()
        });

    let stand = match Stand::create() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("agentbook scenarios: cannot create the stand: {e}");
            std::process::exit(1);
        }
    };
    let mut failed = Vec::new();
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        for (name, step) in STEPS {
            if only.as_ref().is_some_and(|o| !o.iter().any(|n| n == name)) {
                continue;
            }
            println!("step {name}");
            let started = Instant::now();
            match step(&stand) {
                Ok(()) => println!("step {name}: ok ({:.0?})", started.elapsed()),
                Err(e) => {
                    println!("step {name}: FAILED ({:.0?})\n{e}", started.elapsed());
                    failed.push(*name);
                    // Later steps build on earlier ones.
                    break;
                }
            }
        }
    }));
    stand.cleanup();
    if result.is_err() {
        eprintln!("agentbook scenarios: a step panicked");
        std::process::exit(1);
    }
    if !failed.is_empty() {
        eprintln!("agentbook scenarios: failed steps: {}", failed.join(", "));
        std::process::exit(1);
    }
    println!("agentbook scenarios: all steps passed");
}
