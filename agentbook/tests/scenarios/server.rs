//! The local file server that stands in for nodejs.org and registry.npmjs.org: it serves the
//! stand's cache folder by file name (`/nodejs/dist/<v>/<file>`, `/npm/@devcontainers/cli/-/<file>`),
//! counts requests per file and can break one file on purpose: a corrupted byte (checksum
//! mismatch) or a connection cut halfway (a network cut mid-download).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// Full length, one byte changed in the middle.
    Corrupt,
    /// Full `Content-Length` announced, half the body sent, then the connection closed.
    Cut,
}

struct Shared {
    dir: PathBuf,
    faults: Mutex<HashMap<String, Fault>>,
    requests: Mutex<HashMap<String, u32>>,
}

pub struct FileServer {
    pub base: String,
    shared: Arc<Shared>,
}

impl FileServer {
    pub fn start(dir: PathBuf) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let base = format!("http://{}", listener.local_addr()?);
        let shared = Arc::new(Shared {
            dir,
            faults: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
        });
        let accept = shared.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let s = accept.clone();
                std::thread::spawn(move || {
                    let _ = serve(&s, stream);
                });
            }
        });
        Ok(Self { base, shared })
    }

    pub fn set_fault(&self, file: &str, fault: Option<Fault>) {
        let mut faults = self.shared.faults.lock().unwrap();
        match fault {
            Some(f) => faults.insert(file.to_string(), f),
            None => faults.remove(file),
        };
    }

    /// Requests served so far, all files together.
    pub fn total_requests(&self) -> u32 {
        self.shared.requests.lock().unwrap().values().sum()
    }
}

fn serve(shared: &Shared, mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
    }
    let path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let file = path.rsplit('/').next().unwrap_or("").to_string();
    *shared
        .requests
        .lock()
        .unwrap()
        .entry(file.clone())
        .or_insert(0) += 1;
    let data = if file.is_empty() || file.contains("..") {
        None
    } else {
        std::fs::read(shared.dir.join(&file)).ok()
    };
    let Some(mut data) = data else {
        stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?;
        return Ok(());
    };
    let fault = shared.faults.lock().unwrap().get(&file).copied();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        data.len()
    );
    stream.write_all(header.as_bytes())?;
    match fault {
        Some(Fault::Corrupt) => {
            let mid = data.len() / 2;
            data[mid] ^= 0xff;
            stream.write_all(&data)?;
        }
        Some(Fault::Cut) => {
            stream.write_all(&data[..data.len() / 2])?;
            stream.flush()?;
            let _ = stream.shutdown(Shutdown::Both);
            return Ok(());
        }
        None => stream.write_all(&data)?,
    }
    stream.flush()?;
    let _ = stream.shutdown(Shutdown::Write);
    Ok(())
}
