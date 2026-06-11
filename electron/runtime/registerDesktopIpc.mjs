// Tauri migration (Phase 1): implementation moved to src/desktop/runtime/ so
// the Node sidecar's control uplink can reuse the SAME channel registration
// (SSOT for the desktop lifecycle surface). This stub keeps existing Electron
// imports working until electron/ is retired (Phase 6).
export { registerDesktopRuntimeIpc } from "../../src/desktop/runtime/registerDesktopIpc.js";
