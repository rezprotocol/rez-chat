function sanitizeError(err) {
  return {
    message: err && err.message ? String(err.message) : "Desktop IPC failed",
    code: err && err.code ? String(err.code) : "DESKTOP_IPC_ERROR",
  };
}

async function invoke(handler, args) {
  try {
    return { ok: true, result: await handler(args || {}) };
  } catch (err) {
    return { ok: false, error: sanitizeError(err) };
  }
}

/**
 * Registers the desktop IPC surface.
 *
 * Two generic channels carry all bus traffic:
 *   - `bus:call`   directive dispatch via DesktopBusBridge.call(method, params)
 *   - `bus:event`  event push via DesktopBusBridge.subscribeEvents(...)
 *
 * Plus narrow lifecycle handlers (vault + runtime). NO per-directive handlers
 * here — adding a new bus directive requires ZERO changes in this file. The
 * allowlist is enforced by test/architecture.no-ipc-facade.test.js.
 */
export function registerDesktopRuntimeIpc({ ipcMain, supervisor, biometricGate = null, getWindow = null, confirmUnlockWithDevice = null } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new Error("registerDesktopRuntimeIpc requires ipcMain");
  }
  if (!supervisor) throw new Error("registerDesktopRuntimeIpc requires supervisor");

  let busEventUnsub = null;
  const detachBusEvents = () => {
    if (busEventUnsub) {
      busEventUnsub();
      busEventUnsub = null;
    }
  };
  const attachBusEvents = () => {
    if (busEventUnsub) return;
    busEventUnsub = supervisor.getBusBridge().subscribeEvents((envelope) => {
      const win = typeof getWindow === "function" ? getWindow() : null;
      if (!win || !win.webContents || typeof win.webContents.send !== "function") return;
      win.webContents.send("bus:event", envelope);
    });
  };

  ipcMain.handle("desktop:vault:status", () => invoke(() => supervisor.vaultStatus()));
  ipcMain.handle("desktop:vault:createAccount", (_event, args = {}) => invoke((params) => supervisor.createAccount(params), args));
  ipcMain.handle("desktop:vault:unlock", (_event, args = {}) => invoke((params) => supervisor.unlock(params), args));
  ipcMain.handle("desktop:vault:unlockWithDevice", (_event, args = {}) => invoke(async (params) => {
    // SECURITY_AUDIT MED-10: a renderer-side compromise can call this IPC
    // programmatically. A native confirmation dialog (injected from main.mjs)
    // gates the biometric prompt behind an interaction the renderer cannot
    // fake. Tests may inject a no-op confirm to bypass this. Cancel here
    // surfaces a typed error to the caller; no biometric is shown.
    if (typeof confirmUnlockWithDevice === "function") {
      const confirmed = await confirmUnlockWithDevice();
      if (!confirmed) {
        const err = new Error("Unlock cancelled");
        err.code = "UNLOCK_CANCELLED";
        throw err;
      }
    }
    // SECURITY_AUDIT MED-18: skip the biometric prompt when no biometric
    // API is available (Linux today). Vault unlock then falls back to the
    // safeStorage-gated path inside supervisor.unlockWithDevice. The
    // gate-throws-on-Linux semantic is BiometricGate.requireBiometric;
    // call it only after confirming availability.
    if (biometricGate
        && typeof biometricGate.isAvailable === "function"
        && biometricGate.isAvailable()
        && typeof biometricGate.requireBiometric === "function") {
      await biometricGate.requireBiometric({ reason: "Unlock Rez" });
    }
    return supervisor.unlockWithDevice(params);
  }, args));
  ipcMain.handle("desktop:vault:disableDeviceUnlock", (_event, args = {}) => invoke((params) => supervisor.disableDeviceUnlock(params), args));
  ipcMain.handle("desktop:vault:lock", () => invoke(() => supervisor.lock()));
  ipcMain.handle("desktop:vault:listAccounts", () => invoke(() => supervisor.listAccounts()));
  ipcMain.handle("desktop:vault:getActiveIdentitySummary", () => invoke(() => supervisor.getActiveIdentitySummary()));
  ipcMain.handle("desktop:vault:setProfileName", (_event, args = {}) => invoke((params) => supervisor.setProfileName(params), args));
  ipcMain.handle("desktop:vault:setAvatarFileHash", (_event, args = {}) => invoke((params) => supervisor.setAvatarFileHash(params), args));
  ipcMain.handle("desktop:vault:getAvatarFileHash", (_event, args = {}) => invoke((params) => supervisor.getAvatarFileHash(params), args));
  ipcMain.handle("desktop:vault:setAvatarDataB64", (_event, args = {}) => invoke((params) => supervisor.setAvatarDataB64(params), args));
  ipcMain.handle("desktop:vault:getAvatarDataB64", (_event, args = {}) => invoke((params) => supervisor.getAvatarDataB64(params), args));
  ipcMain.handle("desktop:vault:revealMnemonic", (_event, args = {}) => invoke((params) => supervisor.revealMnemonic(params), args));
  ipcMain.handle("desktop:vault:resetPasswordWithMnemonic", (_event, args = {}) => invoke((params) => supervisor.resetPasswordWithMnemonic(params), args));
  ipcMain.handle("desktop:vault:changePassword", (_event, args = {}) => invoke((params) => supervisor.changePassword(params), args));
  ipcMain.handle("desktop:vault:exportBackup", (_event, args = {}) => invoke((params) => supervisor.exportBackup(params), args));
  ipcMain.handle("desktop:vault:importBackup", (_event, args = {}) => invoke((params) => supervisor.importBackup(params), args));
  ipcMain.handle("desktop:vault:purgeAccount", (_event, args = {}) => invoke((params) => supervisor.purgeAccount(params), args));

  ipcMain.handle("desktop:runtime:status", () => invoke(() => supervisor.status()));
  ipcMain.handle("desktop:runtime:connect", () => invoke(async () => {
    const summary = await supervisor.connect();
    attachBusEvents();
    return summary;
  }));
  ipcMain.handle("desktop:runtime:disconnect", () => invoke(async () => {
    detachBusEvents();
    return supervisor.disconnect();
  }));

  ipcMain.handle("bus:call", (_event, args = {}) => invoke(() => {
    // SECURITY_AUDIT MED-17: every renderer-initiated directive resets the
    // vault's idle auto-relock timer. The absolute timer is independent.
    if (typeof supervisor.noteVaultActivity === "function") {
      supervisor.noteVaultActivity();
    }
    const method = args && typeof args.method === "string" ? args.method : "";
    const params = args && args.params != null ? args.params : {};
    return supervisor.getBusBridge().call(method, params);
  }));

  return detachBusEvents;
}
