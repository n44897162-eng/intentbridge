//! Native JSON-lines bridge for desktop test harnesses.
//!
//! Each line is one command (same schema as the WASM ABI); each response line
//! is `{"ok":true,"result":...}` or `{"ok":false,"error":...}`.

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = ib_runtime::abi::command_once(&line);
        let _ = writeln!(stdout, "{}", response);
        let _ = stdout.flush();
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}
