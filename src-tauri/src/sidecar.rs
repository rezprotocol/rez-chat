//! Node sidecar supervision: spawn, ready-handshake, graceful shutdown,
//! and the Rust half of the zombie-prevention scheme.
//!
//! Layers owned here:
//!   1. Graceful shutdown — `shutdown()` writes `{"op":"shutdown"}` over the
//!      HostChannel stdin, waits up to 5s, then kills.
//!   2. stdin pipe ownership — the child's stdin handle lives inside
//!      `SidecarHandle` for the entire app lifetime. If this process dies by
//!      ANY means, the OS closes the pipe and the sidecar's stdin-EOF
//!      watchdog fires (sidecar-side layer 2).
//!   3. Windows Job Object — `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the
//!      kernel reap the sidecar when this process exits, even on a hard
//!      crash where no userspace cleanup runs. macOS/Linux rely on layer 2
//!      (stdin EOF + ppid polling in the sidecar).
//!
//! The sidecar prints marker-prefixed JSON frames on stdout (see
//! src/desktop/sidecar/HostChannel.js). This module parses them, resolves
//! the ready handshake, and forwards host-bound requests to a handler.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const HOST_CHANNEL_MARKER: &str = "@@REZ@@";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct SidecarReady {
    pub port: u16,
    // pid + instance_id feed the crash-restart UX and diagnostics (Phase 4).
    #[allow(dead_code)]
    pub pid: u32,
    #[allow(dead_code)]
    pub instance_id: String,
}

#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Node binary. Resolution order: REZ_NODE_BIN env, bundled sidecar
    /// binary (phase 5), `node` from PATH (dev).
    pub node_bin: PathBuf,
    /// Absolute path to src/desktop/sidecar-main.js.
    pub entry: PathBuf,
    /// Working directory for the sidecar (the rez-chat root).
    pub cwd: PathBuf,
    pub user_data_dir: PathBuf,
    pub control_token: String,
    /// Extra WS origins (the webview origin, platform-dependent).
    pub allowed_ws_origins: Vec<String>,
}

/// Frames the sidecar sends that the host must act on (Phase 3 adds
/// keychain/biometric requests; Phase 4 adds badge updates).
pub type HostRequestHandler = dyn Fn(&str, &serde_json::Value) -> Result<serde_json::Value, String> + Send + Sync;

pub struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pub ready: SidecarReady,
    #[cfg(windows)]
    _job: windows_job::JobObject,
}

fn write_frame(stdin: &Arc<Mutex<Option<ChildStdin>>>, frame: &serde_json::Value) {
    let mut slot = stdin.lock().expect("sidecar stdin lock poisoned");
    if let Some(writer) = slot.as_mut() {
        let line = format!("{}{}\n", HOST_CHANNEL_MARKER, frame);
        if let Err(err) = writer.write_all(line.as_bytes()) {
            eprintln!("[rez-shell] host-channel write failed: {}", err);
        }
        let _ = writer.flush();
    }
}

impl SidecarHandle {
    /// Spawn the sidecar and block until its ready handshake (or timeout).
    pub fn spawn(
        config: &SidecarConfig,
        on_request: Arc<HostRequestHandler>,
    ) -> Result<Self, String> {
        let mut command = Command::new(&config.node_bin);
        command
            .arg(&config.entry)
            .arg("--rez-sidecar")
            .current_dir(&config.cwd)
            .env("REZ_CHAT_USER_DATA_DIR", &config.user_data_dir)
            .env("REZ_CONTROL_TOKEN", &config.control_token)
            .env("REZ_ALLOWED_WS_ORIGIN", config.allowed_ws_origins.join(","))
            .env("REZ_CHAT_SKIP_UI_CHECK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = command
            .spawn()
            .map_err(|err| format!("failed to spawn sidecar ({:?}): {}", config.node_bin, err))?;

        #[cfg(windows)]
        let job = windows_job::JobObject::assign(&child)
            .map_err(|err| format!("failed to assign sidecar to job object: {}", err))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar stdout not piped".to_string())?;

        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let reader_stdin = Arc::clone(&stdin);
        let (ready_tx, ready_rx) = mpsc::channel::<SidecarReady>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(value) => value,
                    Err(_) => break,
                };
                if let Some(json) = line.strip_prefix(HOST_CHANNEL_MARKER) {
                    let frame: serde_json::Value = match serde_json::from_str(json) {
                        Ok(value) => value,
                        Err(err) => {
                            eprintln!("[rez-shell] unparseable sidecar frame: {}", err);
                            continue;
                        }
                    };
                    let kind = frame.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                    let op = frame.get("op").and_then(|v| v.as_str()).unwrap_or("");
                    let empty = serde_json::Value::Null;
                    let params = frame.get("params").unwrap_or(&empty);
                    if kind == "evt" && op == "ready" {
                        let port = params.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                        let pid = params.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let instance_id = params
                            .get("instanceId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = ready_tx.send(SidecarReady { port, pid, instance_id });
                        continue;
                    }
                    if kind == "req" {
                        let id = frame.get("id").cloned().unwrap_or(serde_json::Value::Null);
                        let response = match on_request(op, params) {
                            Ok(result) => serde_json::json!({
                                "kind": "res", "id": id, "ok": true, "result": result,
                            }),
                            Err(message) => serde_json::json!({
                                "kind": "res", "id": id, "ok": false,
                                "error": { "message": message, "code": "HOST_REQUEST_ERROR" },
                            }),
                        };
                        write_frame(&reader_stdin, &response);
                        continue;
                    }
                    if kind == "evt" {
                        let _ = on_request(op, params);
                        continue;
                    }
                } else if !line.is_empty() {
                    // Ordinary sidecar log line — forward for visibility.
                    println!("{}", line);
                }
            }
        });

        let ready = match ready_rx.recv_timeout(READY_TIMEOUT) {
            Ok(value) => value,
            Err(_) => {
                let _ = child.kill();
                return Err("sidecar did not report ready within 60s".to_string());
            }
        };
        if ready.port == 0 {
            let _ = child.kill();
            return Err("sidecar ready handshake carried no port".to_string());
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin,
            ready,
            #[cfg(windows)]
            _job: job,
        })
    }

    /// Graceful shutdown (zombie layer 1): ask first, wait, then kill.
    /// Dropping the stdin handle afterwards also fires the sidecar's
    /// stdin-EOF watchdog, so even a sidecar that missed the request exits.
    pub fn shutdown(&self) {
        write_frame(
            &self.stdin,
            &serde_json::json!({
                "kind": "req",
                "id": "host-shutdown",
                "op": "shutdown",
                "params": {}
            }),
        );
        {
            // Close our end of the pipe: belt for the request's braces — a
            // sidecar that missed the request still sees stdin EOF.
            let mut stdin_slot = self.stdin.lock().expect("sidecar stdin lock poisoned");
            *stdin_slot = None;
        }

        let mut child_slot = self.child.lock().expect("sidecar child lock poisoned");
        if let Some(child) = child_slot.as_mut() {
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            eprintln!("[rez-shell] sidecar ignored graceful shutdown — killing");
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(err) => {
                        eprintln!("[rez-shell] sidecar wait failed: {}", err);
                        let _ = child.kill();
                        break;
                    }
                }
            }
        }
        *child_slot = None;
    }

    // Used by the sidecar-crash restart UX (Phase 4) and liveness polling.
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        let mut child_slot = self.child.lock().expect("sidecar child lock poisoned");
        match child_slot.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        // Last-resort reap on normal teardown paths. Crash paths are covered
        // by the OS layers (stdin EOF, ppid watchdog, Windows job object).
        let mut child_slot = self.child.lock().expect("sidecar child lock poisoned");
        if let Some(child) = child_slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *child_slot = None;
    }
}

/// Resolve the Node binary for the sidecar. Order:
///   1. REZ_NODE_BIN env (explicit override)
///   2. dev (debug) builds: `node` on PATH — it matches the architecture of
///      the developer's npm-installed native modules (better-sqlite3). The
///      bundled externalBin follows the RUST target triple, which on a
///      Rosetta-installed rustup is x86_64 even on arm64 Macs; loading an
///      arm64 .node from an x86_64 node aborts the sidecar.
///   3. release builds: the bundled sidecar binary next to the app
///      executable (externalBin), PATH `node` as a last resort.
pub fn resolve_node_bin() -> PathBuf {
    if let Ok(env_bin) = std::env::var("REZ_NODE_BIN") {
        let trimmed = env_bin.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if cfg!(debug_assertions) {
        return PathBuf::from("node");
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            if bundled.exists() {
                return bundled;
            }
        }
    }
    PathBuf::from("node")
}

#[cfg(windows)]
mod windows_job {
    //! Zombie layer 3: kernel-enforced kill-on-close. The job handle lives
    //! as long as the process; when it dies (even SIGKILL-equivalent), the
    //! kernel terminates every process in the job.
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobObject {
        handle: HANDLE,
    }

    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        pub fn assign(child: &Child) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(None, None)
                    .map_err(|err| format!("CreateJobObjectW: {}", err))?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|err| format!("SetInformationJobObject: {}", err))?;
                let process = HANDLE(child.as_raw_handle());
                AssignProcessToJobObject(handle, process)
                    .map_err(|err| format!("AssignProcessToJobObject: {}", err))?;
                Ok(Self { handle })
            }
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}
