//! One-time user-data migration from the Electron install.
//!
//! Electron's userData lived at the productName path ("Rez Chat"):
//!   macOS:   ~/Library/Application Support/Rez Chat
//!   Windows: %APPDATA%\Rez Chat
//!   Linux:   ~/.config/Rez Chat
//! Tauri's app_data_dir is identifier-based (com.rezprotocol.chat).
//!
//! Strategy: when the Tauri dir does not exist and the legacy dir does,
//! ATOMIC RENAME (same volume — Application Support to Application Support).
//! If the rename fails (file lock, permissions), USE THE LEGACY PATH IN
//! PLACE this launch and retry the rename next time — the sidecar takes
//! whatever directory we hand it via REZ_CHAT_USER_DATA_DIR, so nothing
//! else cares where the data lives. NEVER copy-then-delete: a partial copy
//! of vault.db / ratchet state is data corruption.

use std::path::PathBuf;
use tauri::Manager;

const LEGACY_DIR_NAME: &str = "Rez Chat";

fn legacy_user_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library/Application Support")
                .join(LEGACY_DIR_NAME)
        })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join(LEGACY_DIR_NAME))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
        config_home.map(|base| base.join(LEGACY_DIR_NAME))
    }
}

/// Resolve the data dir to use this launch, migrating from Electron when
/// possible. An explicit REZ_CHAT_USER_DATA_DIR (dev profiles, tests)
/// bypasses migration entirely — handled by the caller.
pub fn resolve_data_dir_with_migration(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let target = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {}", err))?;
    if target.exists() {
        return Ok(target);
    }
    let Some(legacy) = legacy_user_data_dir() else {
        return Ok(target);
    };
    // The legacy dir must look like a real rez-chat profile, not an
    // unrelated leftover: the vault db is the marker.
    if !legacy.join("desktop-vault.sqlite").exists() {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!("[rez-shell] migration: cannot create {}: {}", parent.display(), err);
            return Ok(legacy);
        }
    }
    match std::fs::rename(&legacy, &target) {
        Ok(()) => {
            println!(
                "[rez-shell] migrated user data {} -> {}",
                legacy.display(),
                target.display()
            );
            Ok(target)
        }
        Err(err) => {
            // Locked or cross-volume: run from the legacy path this launch,
            // retry the rename on the next one.
            eprintln!(
                "[rez-shell] migration deferred ({}); using legacy dir {}",
                err,
                legacy.display()
            );
            Ok(legacy)
        }
    }
}
