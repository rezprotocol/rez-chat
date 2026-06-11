//! Auto-update via tauri-plugin-updater. Port of electron/runtime/
//! DesktopUpdater.mjs semantics:
//!
//!   - Load-phase gate: `check_and_apply_during_load` runs BEFORE the
//!     sidecar touches reznet, with a bounded timeout and FAIL-OPEN — a
//!     stale client updates here instead of failing against relays it can
//!     no longer talk to, but an unreachable update server never blocks
//!     boot.
//!   - In-session: periodic checks (30s initial delay, then every 6h) that
//!     download in the background and push status to the webview as
//!     "updates:status" events; the UI banner offers Restart.
//!
//! Status payloads mirror DesktopUpdater.getStatus(): {state: "idle" |
//! "checking" | "available" | "downloading" | "downloaded" | "error", ...}.
//! Updater signing keys + endpoint live in tauri.conf.json (packaging
//! phase); until they are configured every check fails soft to "idle".

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

const LOAD_GATE_TIMEOUT: Duration = Duration::from_secs(20);
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const PERIODIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

static UPDATE_DOWNLOADED: AtomicBool = AtomicBool::new(false);
static LAST_STATUS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn emit_status(app: &tauri::AppHandle, status: serde_json::Value) {
    {
        let mut slot = LAST_STATUS.lock().expect("status lock poisoned");
        *slot = Some(status.clone());
    }
    if let Err(err) = app.emit("updates:status", status) {
        eprintln!("[rez-shell] updates:status emit failed: {}", err);
    }
}

pub fn get_status() -> serde_json::Value {
    let slot = LAST_STATUS.lock().expect("status lock poisoned");
    slot.clone().unwrap_or_else(|| json!({ "state": "idle" }))
}

/// Load-phase gate. Returns true when an update is being applied (caller
/// stops the boot — the app restarts into the new version). Bounded and
/// fail-open: any error or timeout lets the boot continue.
pub fn check_and_apply_during_load(app: &tauri::AppHandle) -> bool {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let gate_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let applying = run_load_gate(&gate_app).await;
        let _ = tx.send(applying);
    });
    match rx.recv_timeout(LOAD_GATE_TIMEOUT) {
        Ok(applying) => applying,
        Err(_) => {
            eprintln!("[rez-shell] update gate timed out — continuing boot");
            false
        }
    }
}

async fn run_load_gate(app: &tauri::AppHandle) -> bool {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(err) => {
            eprintln!("[rez-shell] updater unavailable ({}); skipping gate", err);
            return false;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            emit_status(app, json!({ "state": "downloading", "version": update.version }));
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    emit_status(app, json!({ "state": "downloaded", "version": update.version }));
                    // Relaunch into the new version instead of continuing boot.
                    app.restart();
                }
                Err(err) => {
                    eprintln!("[rez-shell] load-gate update install failed: {}", err);
                    emit_status(app, json!({ "state": "error", "message": err.to_string() }));
                    false
                }
            }
        }
        Ok(None) => false,
        Err(err) => {
            // No endpoint configured / offline — fail open.
            eprintln!("[rez-shell] update check failed (continuing): {}", err);
            false
        }
    }
}

/// In-session periodic checks. Downloads in the background; the user applies
/// via the UI banner's Restart button (restart_and_install command).
pub fn start_periodic_checks(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK_DELAY).await;
        loop {
            check_once(&app).await;
            tokio_sleep(PERIODIC_INTERVAL).await;
        }
    });
}

pub fn check_now(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        check_once(&app).await;
    });
}

async fn check_once(app: &tauri::AppHandle) {
    if UPDATE_DOWNLOADED.load(Ordering::SeqCst) {
        return;
    }
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return,
    };
    emit_status(app, json!({ "state": "checking" }));
    match updater.check().await {
        Ok(Some(update)) => {
            emit_status(app, json!({ "state": "downloading", "version": update.version }));
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    UPDATE_DOWNLOADED.store(true, Ordering::SeqCst);
                    emit_status(app, json!({ "state": "downloaded", "version": update.version }));
                }
                Err(err) => {
                    emit_status(app, json!({ "state": "error", "message": err.to_string() }));
                }
            }
        }
        Ok(None) => emit_status(app, json!({ "state": "not-available" })),
        Err(err) => {
            eprintln!("[rez-shell] update check failed: {}", err);
            emit_status(app, json!({ "state": "idle" }));
        }
    }
}

pub fn restart_and_install(app: &tauri::AppHandle) -> bool {
    if !UPDATE_DOWNLOADED.load(Ordering::SeqCst) {
        return false;
    }
    // download_and_install already staged the update; relaunching applies it.
    app.restart();
}

async fn tokio_sleep(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}
