fn main() {
    tauri_plugin::Builder::new(&["dispatch", "subscribe", "shareFile"])
        .ios_path("ios")
        .build();
}
