#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_rez_native::init())
        .run(tauri::generate_context!())
        .expect("Rez mobile host failed");
}
