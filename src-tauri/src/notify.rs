//! Desktop notification posting with sender-avatar support.
//!
//! Electron's renderer used the web Notification API; on macOS Chromium
//! rendered the `icon` option as the notification's content image (the
//! square image on the right), with the app's bundle icon on the left.
//! tauri-plugin-notification cannot attach desktop content images, so the
//! shim routes `new Notification(...)` through this command instead:
//!
//!   - macOS: mac-notification-sys with contentImage — avatar (data: URI)
//!     or the Rez notification mark when the sender has none. The LEFT icon
//!     is always the presenting bundle's icon: the Rez logo in a packaged
//!     .app, the terminal icon for a bare dev binary (macOS gives us no
//!     say in that without a bundle).
//!   - elsewhere: tauri-plugin-notification, passing the icon path through
//!     (honored on Linux; Windows toasts show the app identity).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_ICON_SEQ: AtomicU64 = AtomicU64::new(0);

fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, c) in ALPHABET.iter().enumerate() {
        lookup[*c as usize] = i as u8;
    }
    lookup[b'-' as usize] = 62; // base64url variants
    lookup[b'_' as usize] = 63;
    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in data.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' {
            continue;
        }
        let value = lookup[byte as usize];
        if value == 255 {
            return Err("invalid base64 in icon data URL".to_string());
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Materialize the notification image: a `data:` URI is decoded to a temp
/// file; anything else (the UI's bundled-asset URL, which this process
/// cannot fetch) falls back to the branding mark on disk.
fn resolve_icon_path(chat_root: &Path, icon: &str) -> Option<PathBuf> {
    let trimmed = icon.trim();
    if let Some(rest) = trimmed.strip_prefix("data:") {
        let Some((meta, payload)) = rest.split_once(',') else {
            return fallback_icon_path(chat_root);
        };
        if !meta.contains("base64") {
            return fallback_icon_path(chat_root);
        }
        let bytes = match decode_base64(payload) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("[rez-shell] notification icon decode failed: {}", err);
                return fallback_icon_path(chat_root);
            }
        };
        let ext = if meta.contains("image/png") { "png" } else { "jpg" };
        let seq = TEMP_ICON_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "rez-notify-{}-{}.{}",
            std::process::id(),
            seq,
            ext
        ));
        let written = std::fs::File::create(&path).and_then(|mut f| f.write_all(&bytes));
        match written {
            Ok(()) => Some(path),
            Err(err) => {
                eprintln!("[rez-shell] notification icon write failed: {}", err);
                fallback_icon_path(chat_root)
            }
        }
    } else {
        fallback_icon_path(chat_root)
    }
}

fn fallback_icon_path(chat_root: &Path) -> Option<PathBuf> {
    let path = chat_root.join(
        "node_modules/@rezprotocol/ui/branding/filled-silhouette/rez-icon-mark-notification.png",
    );
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Interactive notifications block a worker thread until the user reacts
/// (or the banner is ignored forever) — cap the concurrent waiters so a
/// busy chat can't accumulate unbounded parked threads. Beyond the cap,
/// notifications still post, just fire-and-forget.
static ACTIVE_WAITERS: AtomicU64 = AtomicU64::new(0);
const MAX_WAITERS: u64 = 12;

#[cfg(target_os = "macos")]
fn post(
    _app: &tauri::AppHandle,
    title: &str,
    body: &str,
    icon_path: Option<&Path>,
    actions: &str,
) -> Result<serde_json::Value, String> {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};

    let mut notification = Notification::default();
    let icon_str = icon_path.map(|path| path.to_string_lossy().to_string());
    if let Some(icon) = icon_str.as_deref() {
        notification.content_image(icon);
    }

    let wants_buttons = matches!(actions, "reply" | "accept-reject");
    let interactive = wants_buttons && ACTIVE_WAITERS.load(Ordering::SeqCst) < MAX_WAITERS;
    if interactive {
        match actions {
            // Inline reply right on the banner — the headline thing the old
            // Electron renderer-Notification path could never do.
            "reply" => {
                notification.main_button(MainButton::Response("Reply"));
                notification.close_button("Dismiss");
            }
            // Consent prompts (e.g. a group member requesting to connect):
            // explicit Accept / Reject, both reported back to the UI.
            _ => {
                notification.main_button(MainButton::SingleAction("Accept"));
                notification.close_button("Reject");
            }
        }
        ACTIVE_WAITERS.fetch_add(1, Ordering::SeqCst);
    } else {
        // Fire-and-forget: don't park a thread waiting for a reaction.
        notification.asynchronous(true);
    }

    let result = mac_notification_sys::send_notification(title, None, body, Some(&notification));
    if interactive {
        ACTIVE_WAITERS.fetch_sub(1, Ordering::SeqCst);
    }
    let response = result.map_err(|err| format!("macOS notification failed: {}", err))?;
    Ok(match response {
        NotificationResponse::ActionButton(_) if actions == "accept-reject" => {
            serde_json::json!({ "action": "accept" })
        }
        NotificationResponse::CloseButton(_) if actions == "accept-reject" => {
            serde_json::json!({ "action": "reject" })
        }
        NotificationResponse::Click | NotificationResponse::ActionButton(_) => {
            serde_json::json!({ "action": "click" })
        }
        NotificationResponse::Reply(text) => {
            serde_json::json!({ "action": "reply", "text": text })
        }
        _ => serde_json::json!({ "action": "none" }),
    })
}

#[cfg(not(target_os = "macos"))]
fn post(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    icon_path: Option<&Path>,
    _actions: &str,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title).body(body);
    if let Some(path) = icon_path {
        builder = builder.icon(path.to_string_lossy().to_string());
    }
    builder
        .show()
        .map_err(|err| format!("notification failed: {}", err))?;
    Ok(serde_json::json!({ "action": "none" }))
}

pub fn send(
    app: &tauri::AppHandle,
    chat_root: &Path,
    title: &str,
    body: &str,
    icon: &str,
    actions: &str,
) -> Result<serde_json::Value, String> {
    let icon_path = if icon.trim().is_empty() {
        fallback_icon_path(chat_root)
    } else {
        resolve_icon_path(chat_root, icon)
    };
    post(app, title, body, icon_path.as_deref(), actions)
}
