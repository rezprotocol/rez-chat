//! Rez Chat desktop shell (Tauri 2).
//!
//! Deliberately thin: every piece of app/protocol logic lives in the Node
//! sidecar (src/desktop/sidecar-main.js); the UI lives in the webview served
//! from the Tauri asset protocol. This crate only does OS plumbing — windows,
//! splash, tray, dialogs, keychain, biometric, updater, sidecar supervision —
//! mirroring what electron/main.mjs used to do. See CLAUDE.md §3 (SSOT)
//! before adding anything here: bus directives NEVER get per-directive Rust
//! commands.
//!
//! Boot sequence (port of electron/runtime/DesktopBootstrap.mjs — same
//! ordering guarantees: update-before-reznet, fail-to-a-state-never-a-hang):
//!   1. splash window up immediately (setup)
//!   2. update gate (bounded, fail-open) BEFORE the sidecar touches reznet
//!   3. spawn sidecar, await ready handshake
//!   4. create main window (hidden), then reveal + retire splash after the
//!      3s minimum splash hold

mod biometric;
mod commands;
mod keychain;
mod migrate;
mod notify;
mod sidecar;
mod tray;
mod updater;

/// Paths shared with webview commands (managed state once boot resolves).
pub struct ShellPaths {
    pub chat_root: PathBuf,
}

use rand::RngCore;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use sidecar::{resolve_node_bin, SidecarConfig, SidecarHandle};

const MIN_SPLASH_VISIBLE: Duration = Duration::from_secs(3);

/// Set while the app is tearing down deliberately, so the sidecar crash
/// monitor does not mistake our own shutdown for a crash.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Webview origins per platform (Tauri asset protocol). The sidecar's WS
/// uplinks only accept loopback origins by default; these are passed through
/// REZ_ALLOWED_WS_ORIGIN so the webview can open ws://127.0.0.1 sockets.
fn webview_ws_origins() -> Vec<String> {
    vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ]
}

/// Electron-compatible platform name: the UI was written against
/// process.platform ("darwin"/"win32"/"linux"), not Rust's OS consts.
pub fn electron_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => {
            if other == "linux" {
                "linux"
            } else {
                other
            }
        }
    }
}

fn generate_control_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    // base64url without padding, matching the sidecar's token shape.
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(43);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in bytes {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(ALPHABET[((buffer >> bits) & 0x3f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (6 - bits)) & 0x3f) as usize] as char);
    }
    out
}

/// rez-chat repo root: in dev it is the parent of src-tauri/; in a packaged
/// app the JS tree ships under the resource directory (packaging phase).
fn resolve_chat_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(env_root) = std::env::var("REZ_CHAT_ROOT") {
        let trimmed = env_root.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if dev_root.join("src/desktop/sidecar-main.js").exists() {
        return dev_root
            .canonicalize()
            .map_err(|err| format!("failed to resolve chat root: {}", err));
    }
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|err| format!("failed to resolve resource dir: {}", err))?;
    Ok(resource_root)
}

fn resolve_user_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(env_dir) = std::env::var("REZ_CHAT_USER_DATA_DIR") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            // Explicit override (dev profiles, tests): no migration.
            return Ok(PathBuf::from(trimmed));
        }
    }
    migrate::resolve_data_dir_with_migration(app)
}

fn build_bootstrap_script(app: &tauri::AppHandle, port: u16, control_token: &str) -> String {
    let bootstrap = serde_json::json!({
        "platform": electron_platform(),
        "appVersion": app.package_info().version.to_string(),
        "shellPort": port,
        "controlToken": control_token,
    });
    // Injected before any page script; the rezDesktop shim reads it at
    // module scope. Object.freeze so page code cannot swap the token later.
    format!(
        "window.__REZ_TAURI_BOOTSTRAP__ = Object.freeze({});",
        bootstrap
    )
}

fn set_splash_status(app: &tauri::AppHandle, phase: &str, message: &str) {
    let payload = serde_json::json!({ "phase": phase, "message": message });
    if let Err(err) = app.emit_to("splash", "splash:status", payload) {
        eprintln!("[rez-shell] splash status emit failed: {}", err);
    }
}

fn create_splash_window(app: &tauri::AppHandle) -> Result<(), String> {
    WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
        .title("Rez")
        .inner_size(480.0, 340.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .center()
        .build()
        .map_err(|err| format!("failed to create splash window: {}", err))?;
    Ok(())
}

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
}

fn create_main_window(app: &tauri::AppHandle, init_script: &str) -> Result<(), String> {
    // Dev-profile window tiling (alice/bob/carol): scripts/desktop-dev-profile.mjs
    // passes position + size through the same env vars the Electron shell used.
    let width = env_f64("REZ_CHAT_WINDOW_WIDTH").unwrap_or(1280.0);
    let height = env_f64("REZ_CHAT_WINDOW_HEIGHT").unwrap_or(860.0);
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Rez Chat")
        .inner_size(width, height)
        .min_inner_size(760.0, 600.0)
        .visible(false)
        .initialization_script(init_script);
    if let (Some(x), Some(y)) = (env_f64("REZ_CHAT_WINDOW_X"), env_f64("REZ_CHAT_WINDOW_Y")) {
        builder = builder.position(x, y);
    }

    #[cfg(target_os = "macos")]
    {
        // Mirrors Electron's titleBarStyle:"hidden": traffic lights overlay
        // the content; the renderer's titlebar-drag regions handle dragging.
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    builder
        .build()
        .map_err(|err| format!("failed to create main window: {}", err))?;
    Ok(())
}

/// Reveal the (hidden) main window once its renderer is ready, then close
/// the splash — after honoring the minimum splash hold so a fast boot does
/// not flash the splash open/closed.
fn handoff_to_main_window(app: &tauri::AppHandle, splash_shown_at: Instant) {
    let elapsed = splash_shown_at.elapsed();
    if elapsed < MIN_SPLASH_VISIBLE {
        std::thread::sleep(MIN_SPLASH_VISIBLE - elapsed);
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

/// Sidecar crash monitor (inverse of the zombie layers): when the sidecar
/// dies while the app is NOT shutting down, surface a native dialog and
/// either relaunch the whole app (fresh sidecar + fresh tokens) or quit.
fn start_crash_monitor(app: tauri::AppHandle, sidecar: Arc<SidecarHandle>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        if sidecar.is_running() {
            continue;
        }
        eprintln!("[rez-shell] sidecar exited unexpectedly");
        let restart = app
            .dialog()
            .message(
                "Rez's background service stopped unexpectedly.\n\n\
                 Restart Rez to reconnect?",
            )
            .title("Rez — backend stopped")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restart".to_string(),
                "Quit".to_string(),
            ))
            .blocking_show();
        if restart {
            // Full relaunch: fresh sidecar, fresh tokens, fresh webview state.
            app.restart();
        }
        app.exit(1);
    });
}

/// Sidecar -> host requests over the stdio HostChannel. The set here is the
/// COMPLETE host surface available to the sidecar — keep it OS-native-only
/// (keychain, biometric, badge), mirroring the transport-generality rule on
/// the JS side.
fn handle_host_request(
    app: &tauri::AppHandle,
    op: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match op {
        "keychain.getOrCreateDeviceKey" => {
            let key_b64 = keychain::get_or_create_device_key()?;
            Ok(serde_json::json!({ "keyB64": key_b64 }))
        }
        "biometric.isAvailable" => Ok(serde_json::json!({
            "available": biometric::is_available(),
        })),
        "biometric.confirmUnlock" => {
            // MED-10 dialog first; only a confirmed dialog reaches the
            // biometric gesture (MED-18: skip gesture when unavailable —
            // the keyring-gated unlock path still applies).
            if !confirm_unlock_with_device(app) {
                return Ok(serde_json::json!({ "confirmed": false }));
            }
            if !biometric::is_available() {
                return Ok(serde_json::json!({ "confirmed": true, "biometric": false }));
            }
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Unlock Rez");
            match biometric::authenticate(reason) {
                Ok(true) => Ok(serde_json::json!({ "confirmed": true, "biometric": true })),
                Ok(false) => Ok(serde_json::json!({ "confirmed": false })),
                Err(err) => Err(format!("biometric authentication failed: {}", err)),
            }
        }
        "badge.set" => {
            let count = params.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
            tray::set_unread_count(app, count);
            Ok(serde_json::json!({ "ok": true }))
        }
        other => Err(format!("unhandled host op '{}'", other)),
    }
}

/// SECURITY_AUDIT MED-10: native confirmation dialog gating the biometric
/// prompt. Runs on the sidecar's host-channel reader thread (never the main
/// thread — the dialog API blocks). The webview cannot draw, dismiss, or
/// click this dialog; a compromised renderer cannot silently chain into a
/// biometric unlock.
fn confirm_unlock_with_device(app: &tauri::AppHandle) -> bool {
    app.dialog()
        .message(
            "Rez is requesting to unlock your local account vault using this \
             device's biometric (Touch ID / Windows Hello).\n\n\
             If you did NOT just take an action that should require an unlock, \
             click Cancel.",
        )
        .title("Unlock Rez")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Unlock".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

/// Phases 2–4 of the boot sequence; runs OFF the main thread so the splash
/// stays responsive. Every failure path lands on the splash as a visible
/// error state — never a hang, never a windowless app.
fn run_boot_sequence(app: tauri::AppHandle) {
    let splash_shown_at = Instant::now();

    // 2. Update gate — BEFORE the sidecar touches reznet (bounded, fail-open).
    set_splash_status(&app, "update", "Checking for updates…");
    if updater::check_and_apply_during_load(&app) {
        set_splash_status(&app, "update", "Updating — Rez will restart…");
        return;
    }

    // 3. Preconditions + backend.
    set_splash_status(&app, "services", "Starting services…");
    let boot = (|| -> Result<(Arc<SidecarHandle>, String, PathBuf), String> {
        let chat_root = resolve_chat_root(&app)?;
        let user_data_dir = resolve_user_data_dir(&app)?;
        std::fs::create_dir_all(&user_data_dir)
            .map_err(|err| format!("can't write app data directory: {}", err))?;

        let control_token = generate_control_token();
        let config = SidecarConfig {
            node_bin: resolve_node_bin(),
            entry: chat_root.join("src/desktop/sidecar-main.js"),
            cwd: chat_root.clone(),
            user_data_dir,
            control_token: control_token.clone(),
            allowed_ws_origins: webview_ws_origins(),
        };
        let request_app = app.clone();
        let on_request = Arc::new(move |op: &str, params: &serde_json::Value| {
            handle_host_request(&request_app, op, params)
        });
        let sidecar = Arc::new(SidecarHandle::spawn(&config, on_request)?);
        Ok((sidecar, control_token, chat_root))
    })();

    let (sidecar, control_token, chat_root) = match boot {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[rez-shell] boot failed: {}", err);
            set_splash_status(&app, "error", &format!("Couldn't start Rez: {}", err));
            return;
        }
    };

    // 4. Main window (hidden) + handoff.
    set_splash_status(&app, "handoff", "Opening…");
    let init_script = build_bootstrap_script(&app, sidecar.ready.port, &control_token);
    app.manage(Arc::clone(&sidecar));
    app.manage(ShellPaths { chat_root: chat_root.clone() });
    if let Err(err) = create_main_window(&app, &init_script) {
        set_splash_status(&app, "error", &format!("Couldn't open Rez: {}", err));
        return;
    }
    if let Err(err) = tray::create_tray(&app, &chat_root) {
        // Tray failure is cosmetic — log and continue, same as Electron.
        eprintln!("[rez-shell] {}", err);
    }
    start_crash_monitor(app.clone(), Arc::clone(&sidecar));
    handoff_to_main_window(&app, splash_shown_at);
    updater::start_periodic_checks(app.clone());
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::desktop_get_app_info,
            commands::desktop_open_external,
            commands::backup_save_to_file,
            commands::backup_open_file,
            commands::updates_get_status,
            commands::updates_restart_and_install,
            commands::desktop_notify,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 1. Splash up first — there is always a window from this point
            //    on. The rest of the boot runs off-thread so the splash
            //    stays responsive; its static "Starting…" text covers the
            //    instant before its event listener attaches.
            create_splash_window(&handle).map_err(std::io::Error::other)?;
            std::thread::spawn(move || run_boot_sequence(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Rez Chat shell");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            SHUTTING_DOWN.store(true, Ordering::SeqCst);
            // Zombie layer 1: graceful sidecar stop on every normal exit
            // path. Crash paths are covered by stdin EOF / ppid / job object.
            if let Some(sidecar) = app_handle.try_state::<Arc<SidecarHandle>>() {
                sidecar.shutdown();
            }
        }
    });
}
