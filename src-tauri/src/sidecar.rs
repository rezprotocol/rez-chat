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
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone)]
pub struct SidecarReady {
    pub port: u16,
    // pid + instance_id feed the crash-restart UX and diagnostics (Phase 4).
    #[allow(dead_code)]
    pub pid: u32,
    #[allow(dead_code)]
    pub instance_id: String,
}

enum BootSignal {
    Ready(SidecarReady),
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Debug builds permit a developer override or PATH Node. Packaged
    /// builds require their bundled Node and fail closed if it is absent.
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

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn await_ready(
    child: &mut Child,
    boot_rx: &mpsc::Receiver<BootSignal>,
    timeout: Duration,
) -> Result<SidecarReady, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            stop_child(child);
            return Err(format!(
                "sidecar did not report ready within {}s",
                timeout.as_secs()
            ));
        }
        let remaining = deadline.saturating_duration_since(now);
        let poll_for = remaining.min(READY_POLL_INTERVAL);
        match boot_rx.recv_timeout(poll_for) {
            Ok(BootSignal::Ready(ready)) => return Ok(ready),
            Ok(BootSignal::Failed(message)) => {
                stop_child(child);
                return Err(format!("sidecar failed before ready: {}", message));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let detail = match child.try_wait() {
                    Ok(Some(status)) => format!("sidecar exited before ready ({})", status),
                    Ok(None) => "sidecar closed its output before ready".to_string(),
                    Err(err) => format!("sidecar status check failed before ready: {}", err),
                };
                stop_child(child);
                return Err(detail);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("sidecar exited before ready ({})", status));
            }
            Ok(None) => {}
            Err(err) => {
                stop_child(child);
                return Err(format!("sidecar status check failed before ready: {}", err));
            }
        }
    }
}

impl SidecarHandle {
    /// Spawn the sidecar and block until its ready handshake (or timeout).
    pub fn spawn(
        config: &SidecarConfig,
        on_request: Arc<HostRequestHandler>,
    ) -> Result<Self, String> {
        let mut command = Command::new(&config.node_bin);
        configure_node_environment(&mut command);
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
        let (boot_tx, boot_rx) = mpsc::channel::<BootSignal>();
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
                        let _ = boot_tx.send(BootSignal::Ready(SidecarReady {
                            port,
                            pid,
                            instance_id,
                        }));
                        continue;
                    }
                    if kind == "evt" && op == "boot.failed" {
                        let message = params
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown sidecar startup failure")
                            .to_string();
                        let _ = boot_tx.send(BootSignal::Failed(message));
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

        let ready = await_ready(&mut child, &boot_rx, READY_TIMEOUT)?;
        if ready.port == 0 {
            stop_child(&mut child);
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

// The key-holding Node process receives only OS/session plumbing. In
// particular, Node flags, module paths, loader hooks, dynamic-library
// injection, proxies and Rez developer overrides never cross this boundary.
fn configure_node_environment(command: &mut Command) {
    command.env_clear();
    for name in [
        "HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP",
        "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USERPROFILE",
        "APPDATA", "LOCALAPPDATA", "SystemRoot", "WINDIR", "COMSPEC",
        "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn node_binary_path(debug: bool, override_path: Option<PathBuf>, executable: Option<PathBuf>) -> Result<PathBuf, String> {
    if debug {
        if let Some(path) = override_path {
            if !path.as_os_str().is_empty() {
                return Ok(path);
            }
        }
        return Ok(PathBuf::from("node"));
    }
    let executable = executable.ok_or("cannot locate the packaged launcher")?;
    let directory = executable.parent().ok_or("packaged launcher has no parent directory")?;
    let bundled = directory.join(if cfg!(windows) { "rez-chat-node.exe" } else { "rez-chat-node" });
    if !bundled.is_file() {
        return Err("bundled Node executable is missing; reinstall this desktop candidate".to_string());
    }
    Ok(bundled)
}

pub fn resolve_node_bin() -> Result<PathBuf, String> {
    node_binary_path(
        cfg!(debug_assertions),
        std::env::var("REZ_NODE_BIN").ok().map(|value| PathBuf::from(value.trim())),
        std::env::current_exe().ok(),
    )
}

#[cfg(test)]
mod launcher_security_tests {
    use super::*;

    #[test]
    fn sidecar_environment_drops_injection_and_developer_values() {
        let mut command = Command::new("unused");
        for name in ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "REZ_CHAT_ROOT", "REZ_NODE_BIN", "REZ_CONTROL_TOKEN", "HTTPS_PROXY"] {
            command.env(name, "hostile-parent-value");
        }
        configure_node_environment(&mut command);
        let retained: Vec<_> = command.get_envs().filter_map(|(name, value)| value.map(|_| name)).collect();
        for name in ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "REZ_CHAT_ROOT", "REZ_NODE_BIN", "REZ_CONTROL_TOKEN", "HTTPS_PROXY"] {
            assert!(!retained.iter().any(|key| *key == name));
        }
        if std::env::var_os("HOME").is_some() {
            assert!(retained.iter().any(|key| *key == "HOME"));
        }
    }

    #[test]
    fn packaged_node_never_uses_developer_override_or_path_fallback() {
        let directory = std::env::temp_dir().join(format!("rez-node-resolution-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("rez-chat-shell");
        assert!(node_binary_path(false, Some(PathBuf::from("hostile-node")), Some(executable.clone())).is_err());
        let bundled = directory.join(if cfg!(windows) { "rez-chat-node.exe" } else { "rez-chat-node" });
        std::fs::write(&bundled, "test fixture, never executed").unwrap();
        assert_eq!(node_binary_path(false, Some(PathBuf::from("hostile-node")), Some(executable)).unwrap(), bundled);
        assert!(node_binary_path(false, None, None).is_err());
        assert_eq!(node_binary_path(true, Some(PathBuf::from("developer-node")), None).unwrap(), PathBuf::from("developer-node"));
        assert_eq!(node_binary_path(true, None, None).unwrap(), PathBuf::from("node"));
        std::fs::remove_dir_all(directory).unwrap();
    }
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
