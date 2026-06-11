// Tauri migration (Phase 1): implementation moved to src/desktop/runtime/ so
// the Node sidecar can host it without Electron. This stub keeps existing
// Electron imports working until electron/ is retired (Phase 6).
export { DesktopVaultService } from "../../src/desktop/runtime/DesktopVaultService.js";
