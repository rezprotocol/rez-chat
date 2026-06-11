//! System tray + unread badge. Port of electron/runtime/DesktopTray.mjs:
//! the branding glyph (cropped to its opaque bounds, template-tinted on
//! macOS), menu (Open Rez / unread line / Check for Updates / Quit), the
//! menu-bar count title, tooltip, and the dock badge. The unread number is
//! computed in the SIDECAR (it owns the chat-server) and arrives over the
//! HostChannel as a `badge.set` notification — see handle_host_request in
//! lib.rs.

use std::path::Path;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

const TRAY_ID: &str = "rez-tray";
// 18pt menu-bar glyph rasterized at 2x, mirroring DesktopTray.#buildIcon.
const TRAY_ICON_PX: u32 = 36;

/// The same branding asset Electron used. Resolves under node_modules both
/// in dev (sibling link) and packaged (bundle.resources includes branding/).
fn tray_icon_path(chat_root: &Path) -> std::path::PathBuf {
    chat_root.join("node_modules/@rezprotocol/ui/branding/filled-silhouette/rez-icon-mark-transparent-filled.png")
}

/// Port of DesktopTray.#cropToGlyph + resize: find the opaque (alpha > 0)
/// bounding box, take a centered square crop with ~8% margin per side, and
/// rasterize to the menu-bar size. The source is a 1024² canvas with the
/// glyph in a smaller off-center box — used as-is it renders as a tiny
/// shifted mark (or, template-tinted, a solid box).
fn load_tray_icon(chat_root: &Path) -> Result<tauri::image::Image<'static>, String> {
    let path = tray_icon_path(chat_root);
    let decoded = image::open(&path)
        .map_err(|err| format!("tray icon load failed ({}): {}", path.display(), err))?
        .into_rgba8();
    let (w, h) = decoded.dimensions();
    if w == 0 || h == 0 {
        return Err("tray icon is empty".to_string());
    }

    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0i64;
    let mut max_y = 0i64;
    for (x, y, pixel) in decoded.enumerate_pixels() {
        if pixel.0[3] > 0 {
            if x < min_x {
                min_x = x;
            }
            if (x as i64) > max_x {
                max_x = x as i64;
            }
            if y < min_y {
                min_y = y;
            }
            if (y as i64) > max_y {
                max_y = y as i64;
            }
        }
    }

    let cropped = if (max_x as u32) >= min_x && (max_y as u32) >= min_y {
        let glyph_w = max_x as u32 - min_x + 1;
        let glyph_h = max_y as u32 - min_y + 1;
        let side = ((glyph_w.max(glyph_h) as f64) * 1.16).round() as u32;
        if side <= w && side <= h {
            let center_x = (min_x as f64 + max_x as f64) / 2.0;
            let center_y = (min_y as f64 + max_y as f64) / 2.0;
            let x = (center_x - side as f64 / 2.0).round().clamp(0.0, (w - side) as f64) as u32;
            let y = (center_y - side as f64 / 2.0).round().clamp(0.0, (h - side) as f64) as u32;
            image::imageops::crop_imm(&decoded, x, y, side, side).to_image()
        } else {
            decoded
        }
    } else {
        decoded
    };

    let resized = image::imageops::resize(
        &cropped,
        TRAY_ICON_PX,
        TRAY_ICON_PX,
        image::imageops::FilterType::Lanczos3,
    );
    Ok(tauri::image::Image::new_owned(resized.into_raw(), TRAY_ICON_PX, TRAY_ICON_PX))
}

fn unread_menu_label(count: i64) -> String {
    if count <= 0 {
        return "No unread messages".to_string();
    }
    if count > 99 {
        return "99+ unread".to_string();
    }
    if count == 1 {
        return "1 unread message".to_string();
    }
    format!("{} unread messages", count)
}

fn build_menu(app: &tauri::AppHandle, unread: i64) -> Result<Menu<tauri::Wry>, String> {
    let open_item = MenuItem::with_id(app, "open", "Open Rez", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let unread_item = MenuItem::with_id(app, "unread", unread_menu_label(unread), false, None::<&str>)
        .map_err(|err| err.to_string())?;
    let updates_item = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Rez", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    Menu::with_items(app, &[&open_item, &sep1, &unread_item, &sep2, &updates_item, &quit_item])
        .map_err(|err| err.to_string())
}

pub fn create_tray(app: &tauri::AppHandle, chat_root: &Path) -> Result<(), String> {
    let icon = match load_tray_icon(chat_root) {
        Ok(icon) => icon,
        Err(err) => {
            // Branding asset missing (broken dev layout): fall back to the
            // app icon rather than failing tray creation — same spirit as
            // Electron's tray-is-cosmetic error handling in main.mjs.
            eprintln!("[rez-shell] {} — falling back to app icon", err);
            app.default_window_icon().cloned().ok_or("no app icon")?
        }
    };

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Rez Chat")
        .menu(&build_menu(app, 0)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "check-updates" => {
                crate::updater::check_now(app.clone());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
        .map_err(|err| format!("tray creation failed: {}", err))?;
    Ok(())
}

/// Unread badge: dock badge (macOS) / taskbar badge, plus the menu-bar count
/// title, tooltip, and the menu's unread line. Mirrors
/// DesktopTray.setUnreadCount.
pub fn set_unread_count(app: &tauri::AppHandle, count: i64) {
    let count = count.max(0);
    if let Some(window) = app.get_webview_window("main") {
        let value = if count > 0 { Some(count) } else { None };
        if let Err(err) = window.set_badge_count(value) {
            eprintln!("[rez-shell] badge update failed: {}", err);
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let label = if count > 99 { "99+".to_string() } else { count.to_string() };
        let tooltip = if count > 0 {
            format!("Rez Chat — {} unread", label)
        } else {
            "Rez Chat".to_string()
        };
        let _ = tray.set_tooltip(Some(tooltip));
        #[cfg(target_os = "macos")]
        {
            let title = if count > 0 { Some(label) } else { None };
            let _ = tray.set_title(title);
        }
        match build_menu(app, count) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(err) => eprintln!("[rez-shell] tray menu rebuild failed: {}", err),
        }
    }
}
