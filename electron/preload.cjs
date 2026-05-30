const { contextBridge, ipcRenderer } = require("electron");

function unwrap(promise) {
  return promise.then((response) => {
    if (response && response.ok === true) return response.result;
    const errObj = response && response.error && typeof response.error === "object" ? response.error : {};
    const err = new Error(typeof errObj.message === "string" ? errObj.message : "Desktop request failed");
    err.code = typeof errObj.code === "string" ? errObj.code : "DESKTOP_IPC_ERROR";
    throw err;
  });
}

// Generic bus event listener. ONE ipcRenderer.on subscription regardless of
// how many bus.on(...) callers — we maintain an in-renderer subscriber set
// and fan out per envelope.event. Adding many UI subscribers no longer
// inflates the IPC EventEmitter listener count.
const busEventSubscribers = new Set();
ipcRenderer.on("bus:event", (_event, envelope) => {
  if (!envelope || typeof envelope !== "object") return;
  for (const entry of [...busEventSubscribers]) {
    if (entry.name && envelope.event !== entry.name) continue;
    try {
      entry.handler(envelope.payload, envelope);
    } catch (err) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[rezDesktop.bus] subscriber threw:", err && err.message ? err.message : err);
      }
    }
  }
});

function onBusEvent(eventName, handler) {
  if (typeof handler !== "function") return () => {};
  const entry = {
    name: String(eventName == null ? "" : eventName).trim(),
    handler,
  };
  busEventSubscribers.add(entry);
  return () => {
    busEventSubscribers.delete(entry);
  };
}

// Updater status fan-out. Single ipcRenderer.on subscription; multiple
// renderer subscribers get fanned out from a local set.
const updateStatusSubscribers = new Set();
ipcRenderer.on("desktop:updates:status", (_event, status) => {
  if (!status || typeof status !== "object") return;
  for (const handler of [...updateStatusSubscribers]) {
    try {
      handler(status);
    } catch (err) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[rezDesktop.updates] subscriber threw:", err && err.message ? err.message : err);
      }
    }
  }
});

function onUpdateStatus(handler) {
  if (typeof handler !== "function") return () => {};
  updateStatusSubscribers.add(handler);
  return () => {
    updateStatusSubscribers.delete(handler);
  };
}

contextBridge.exposeInMainWorld("rezDesktop", {
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke("desktop:getAppInfo"),
  openExternal: (url) => ipcRenderer.invoke("desktop:openExternal", url),
  generateSigningKeyPair: () => ipcRenderer.invoke("desktop:generateSigningKeyPair"),
  sign: (options) => ipcRenderer.invoke("desktop:sign", options),
  verify: (options) => ipcRenderer.invoke("desktop:verify", options),
  dhGenerateKeyPair: (options) => ipcRenderer.invoke("desktop:dhGenerateKeyPair", options),
  dhDerive: (options) => ipcRenderer.invoke("desktop:dhDerive", options),
  scrypt: (opts) => ipcRenderer.invoke("desktop:scrypt", opts),
  vault: {
    status: () => unwrap(ipcRenderer.invoke("desktop:vault:status")),
    createAccount: (params) => unwrap(ipcRenderer.invoke("desktop:vault:createAccount", params || {})),
    unlock: (params) => unwrap(ipcRenderer.invoke("desktop:vault:unlock", params || {})),
    unlockWithDevice: (params) => unwrap(ipcRenderer.invoke("desktop:vault:unlockWithDevice", params || {})),
    disableDeviceUnlock: (params) => unwrap(ipcRenderer.invoke("desktop:vault:disableDeviceUnlock", params || {})),
    lock: () => unwrap(ipcRenderer.invoke("desktop:vault:lock")),
    listAccounts: () => unwrap(ipcRenderer.invoke("desktop:vault:listAccounts")),
    getActiveIdentitySummary: () => unwrap(ipcRenderer.invoke("desktop:vault:getActiveIdentitySummary")),
    setProfileName: (params) => unwrap(ipcRenderer.invoke("desktop:vault:setProfileName", params || {})),
    setAvatarFileHash: (params) => unwrap(ipcRenderer.invoke("desktop:vault:setAvatarFileHash", params || {})),
    getAvatarFileHash: (params) => unwrap(ipcRenderer.invoke("desktop:vault:getAvatarFileHash", params || {})),
    setAvatarDataB64: (params) => unwrap(ipcRenderer.invoke("desktop:vault:setAvatarDataB64", params || {})),
    getAvatarDataB64: (params) => unwrap(ipcRenderer.invoke("desktop:vault:getAvatarDataB64", params || {})),
  },
  runtime: {
    connect: () => unwrap(ipcRenderer.invoke("desktop:runtime:connect")),
    disconnect: () => unwrap(ipcRenderer.invoke("desktop:runtime:disconnect")),
    status: () => unwrap(ipcRenderer.invoke("desktop:runtime:status")),
  },
  bus: {
    call: (method, params) => unwrap(ipcRenderer.invoke("bus:call", { method, params: params || {} })),
    on: (eventName, handler) => onBusEvent(eventName, handler),
  },
  updates: {
    onStatus: (handler) => onUpdateStatus(handler),
    getStatus: () => ipcRenderer.invoke("desktop:updates:getStatus"),
    restartAndInstall: () => ipcRenderer.invoke("desktop:updates:restartAndInstall"),
  },
});
