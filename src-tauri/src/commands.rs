//! Webview-callable commands. ONLY OS-native concerns belong here (dialogs,
//! external links, app info) — the vault/runtime/bus surface flows over the
//! sidecar's /control WebSocket, never through Tauri commands, so the
//! transport-generality guardrail (CLAUDE.md §3) holds on the Rust side too.

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub platform: String,
}

#[tauri::command]
pub fn desktop_get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        app_version: app.package_info().version.to_string(),
        platform: crate::electron_platform().to_string(),
    }
}

fn is_external_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Mirrors electron/main.mjs `desktop:openExternal`: http/https only,
/// returns false (not an error) for anything else.
#[tauri::command]
pub fn desktop_open_external(app: tauri::AppHandle, url: String) -> bool {
    if !is_external_http_url(&url) {
        return false;
    }
    match app.opener().open_url(url, None::<String>) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[rez-shell] openExternal failed: {}", err);
            false
        }
    }
}

/// Desktop alert with sender-avatar support (see notify.rs). `icon` is the
/// web-Notification icon option: a data: URI avatar or an asset URL (which
/// falls back to the Rez branding mark). `actions` selects the macOS banner
/// buttons: "reply" (inline reply field) or "accept-reject"; the returned
/// value reports the user's reaction ({action: "click" | "reply" | "accept"
/// | "reject" | "none", text?}) — possibly much later, when they interact
/// with the banner. Runs on a worker (async command + spawn_blocking),
/// never the main thread.
#[tauri::command]
pub async fn desktop_notify(
    app: tauri::AppHandle,
    title: String,
    body: String,
    icon: Option<String>,
    actions: Option<String>,
) -> Result<serde_json::Value, String> {
    let chat_root = {
        let paths = app
            .try_state::<crate::ShellPaths>()
            .ok_or("shell paths not ready")?;
        paths.chat_root.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::notify::send(
            &app,
            &chat_root,
            &title,
            &body,
            icon.as_deref().unwrap_or(""),
            actions.as_deref().unwrap_or(""),
        )
    })
    .await
    .map_err(|err| format!("notification task failed: {}", err))?
}

#[tauri::command]
pub fn updates_get_status() -> serde_json::Value {
    crate::updater::get_status()
}

#[tauri::command]
pub fn updates_restart_and_install(app: tauri::AppHandle) -> bool {
    crate::updater::restart_and_install(&app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSaveResult {
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

/// Mirrors electron/main.mjs `desktop:backup:saveToFile`. The envelope is
/// already ciphertext (encrypted under the seed KEK in the sidecar's vault);
/// this command only picks a path and writes bytes.
#[tauri::command]
pub async fn backup_save_to_file(
    app: tauri::AppHandle,
    envelope: serde_json::Value,
    suggested_name: Option<String>,
) -> Result<BackupSaveResult, String> {
    if !envelope.is_object() {
        return Err("backup_save_to_file requires an envelope object".to_string());
    }
    let file_name = suggested_name.unwrap_or_else(|| "rez-backup.json".to_string());
    let picked = app
        .dialog()
        .file()
        .set_title("Save Rez backup")
        .set_file_name(&file_name)
        .add_filter("Rez Backup", &["json"])
        .blocking_save_file();
    let Some(path) = picked else {
        return Ok(BackupSaveResult { canceled: true, file_path: None });
    };
    let path = path
        .into_path()
        .map_err(|err| format!("invalid save path: {}", err))?;
    let body = serde_json::to_string_pretty(&envelope)
        .map_err(|err| format!("could not serialize backup: {}", err))?;
    std::fs::write(&path, body).map_err(|err| format!("could not save backup: {}", err))?;
    Ok(BackupSaveResult {
        canceled: false,
        file_path: Some(path.to_string_lossy().to_string()),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOpenResult {
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope: Option<serde_json::Value>,
}

/// Mirrors electron/main.mjs `desktop:backup:openFile`.
#[tauri::command]
pub async fn backup_open_file(app: tauri::AppHandle) -> Result<BackupOpenResult, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Restore Rez backup")
        .add_filter("Rez Backup", &["json"])
        .blocking_pick_file();
    let Some(path) = picked else {
        return Ok(BackupOpenResult { canceled: true, envelope: None });
    };
    let path = path
        .into_path()
        .map_err(|err| format!("invalid file path: {}", err))?;
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("could not open backup: {}", err))?;
    let envelope: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| "Selected file is not a valid Rez backup (JSON parse failed)".to_string())?;
    Ok(BackupOpenResult {
        canceled: false,
        envelope: Some(envelope),
    })
}
