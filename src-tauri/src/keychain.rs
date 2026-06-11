//! OS-keychain device key for the sidecar's KeyringSafeStorage (the
//! Electron-safeStorage replacement). The keyring crate maps to the macOS
//! Keychain, Windows Credential Manager, and libsecret/Secret Service —
//! the same backend set Electron's safeStorage used.
//!
//! The 32-byte key is generated on first use and handed to the sidecar over
//! the stdio HostChannel ONLY (never to the webview). The sidecar performs
//! the actual AES-256-GCM locally; this module is just keyed storage.

use rand::RngCore;

const SERVICE: &str = "com.rezprotocol.chat";
const ACCOUNT: &str = "rez-device-unlock-key";

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn looks_like_key(value: &str) -> bool {
    // 32 bytes -> 44 base64 chars with one '=' pad.
    value.len() == 44 && value.ends_with('=')
}

/// Fetch the device key, creating it on first run. Returns base64.
pub fn get_or_create_device_key() -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|err| format!("keychain entry unavailable: {}", err))?;
    match entry.get_password() {
        Ok(existing) => {
            if looks_like_key(&existing) {
                return Ok(existing);
            }
            // Malformed entry (manual edit, partial write): replace it.
            eprintln!("[rez-shell] keychain device key malformed — regenerating");
        }
        Err(keyring::Error::NoEntry) => {}
        Err(err) => return Err(format!("keychain read failed: {}", err)),
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let encoded = encode_base64(&bytes);
    entry
        .set_password(&encoded)
        .map_err(|err| format!("keychain write failed: {}", err))?;
    Ok(encoded)
}
