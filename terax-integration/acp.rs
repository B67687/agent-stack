use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

pub struct AcpState(pub Mutex<Option<Child>>);

impl Default for AcpState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AcpStreamEvent {
    Chunk { text: String },
    End,
    Error { message: String },
}

/// Spawn `omp acp` and send initialize.
#[tauri::command]
pub fn acp_initialize(state: State<'_, AcpState>) -> Result<Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(serde_json::json!({"success": true, "alreadyInitialized": true}));
    }

    // Initialize via one-shot: echo JSON | omp acp
    let init_req = serde_json::json!({
        "jsonrpc": "2.0", "method": "initialize",
        "params": { "protocolVersion": 1 }, "id": 1
    });

    let output = Command::new("sh")
        .arg("-c")
        .arg(format!("echo '{}' | omp acp", 
            init_req.to_string().replace('\'', "'\\''")))
        .output()
        .map_err(|e| format!("Failed to spawn omp acp. Install: bun install -g @oh-my-pi/pi-coding-agent\nError: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    if !output.status.success() {
        return Err(format!("ACP exited with code {}: {}", 
            output.status.code().unwrap_or(-1), stderr));
    }

    let result: Value = stdout.lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| format!("No JSON-RPC response. Stderr: {}", stderr))?;

    // Spawn persistent process for session mode
    let persistent = Command::new("omp")
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ACP session process: {}", e))?;

    *guard = Some(persistent);
    Ok(serde_json::json!({"success": true, "result": result}))
}

/// Send a JSON-RPC request and return the response (non-streaming).
#[tauri::command]
pub fn acp_send(state: State<'_, AcpState>, method: String, params: Value) -> Result<Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("ACP not initialized")?;

    let id: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let request = serde_json::json!({
        "jsonrpc": "2.0", "method": method, "params": params, "id": id
    });

    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, "{}", request).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    } else {
        return Err("ACP stdin not available".to_string());
    }

    if let Some(stdout) = child.stdout.as_mut() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            if let Ok(parsed) = serde_json::from_str::<Value>(&line) {
                if parsed.get("id").and_then(|v| v.as_u64()) == Some(id) {
                    return Ok(parsed);
                }
            }
        }
    }
    Err("No matching response from ACP".to_string())
}

/// Send a streaming prompt via ACP. Reads line by line from stdout and sends
/// session/update events as Chunks, then End when the matching response arrives.
#[tauri::command]
pub async fn acp_send_stream(
    state: State<'_, AcpState>,
    session_id: String,
    text: String,
    on_event: Channel<AcpStreamEvent>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("ACP not initialized")?;

    let id: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text}]
        },
        "id": id
    });

    // Send request via stdin
    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, "{}", request).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    } else {
        let _ = on_event.send(AcpStreamEvent::Error {
            message: "ACP stdin not available".to_string(),
        });
        return Err("ACP stdin not available".to_string());
    }

    // Read stdout line by line, streaming session/update events
    if let Some(stdout) = child.stdout.as_mut() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    let _ = on_event.send(AcpStreamEvent::Error {
                        message: format!("ACP read error: {}", e),
                    });
                    return Err(e.to_string());
                }
            };

            let parsed: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // skip non-JSON lines
            };

            // Check if this is the final response for our request
            if parsed.get("id").and_then(|v| v.as_u64()) == Some(id) {
                let _ = on_event.send(AcpStreamEvent::End);
                return Ok(());
            }

            // Check for streaming session/update
            if parsed.get("method").and_then(|v| v.as_str()) == Some("session/update") {
                if let Some(update) = parsed.get("params") {
                    let update_str = serde_json::to_string(&update).unwrap_or_default();
                    if on_event
                        .send(AcpStreamEvent::Chunk { text: update_str })
                        .is_err()
                    {
                        // Channel dropped (frontend aborted)
                        return Ok(());
                    }
                }
            }
        }
    }

    let _ = on_event.send(AcpStreamEvent::End);
    Ok(())
}

/// Clean up the ACP process.
#[tauri::command]
pub fn acp_dispose(state: State<'_, AcpState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
