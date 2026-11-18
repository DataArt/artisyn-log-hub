#[tokio::main]
async fn main() {
    if let Err(e) = work_hub_server::run().await {
        eprintln!("work-hub-server: {e}");
        std::process::exit(1);
    }
}
