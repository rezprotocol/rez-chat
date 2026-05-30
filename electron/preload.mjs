import { contextBridge, ipcRenderer } from "electron";

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
});
