import { ControlChannelClient } from "./ControlChannelClient.js";

/**
 * Installs `window.rezDesktop` under the Tauri shell.
 *
 * MUST be the first import of src/main.js: the UI reads window.rezDesktop
 * synchronously at module scope (bridge detection + platform class), so the
 * shim has to exist before that module body runs. Under Electron this module
 * is a no-op — preload.cjs already installed the bridge and
 * __REZ_TAURI_BOOTSTRAP__ is absent. In a plain browser both are absent and
 * the app falls back to the /ws path, exactly as before.
 *
 * The surface reproduces electron/preload.cjs exactly. Routing:
 *   vault.* / runtime.* / bus.* / crypto  -> sidecar /control WebSocket
 *   getAppInfo / openExternal / backup.*  -> Tauri commands (__TAURI__,
 *                                            enabled via withGlobalTauri)
 *   updates.*                             -> Tauri events (wired in the
 *                                            updater phase; idle until then)
 *
 * `__REZ_TAURI_BOOTSTRAP__` is injected by the Rust shell as a frozen
 * initialization-script constant: {platform, appVersion, shellPort,
 * controlToken}. Tokens never appear in served HTML or any HTTP response.
 */

function unwrap(promise) {
  return promise.then((response) => {
    if (response && response.ok === true) return response.result;
    const errObj = response && response.error && typeof response.error === "object" ? response.error : {};
    const err = new Error(typeof errObj.message === "string" ? errObj.message : "Desktop request failed");
    err.code = typeof errObj.code === "string" ? errObj.code : "DESKTOP_IPC_ERROR";
    throw err;
  });
}

function tauriInvoke(command, args) {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    return Promise.reject(new Error("Tauri invoke unavailable"));
  }
  return tauri.core.invoke(command, args || {}).catch((raw) => {
    const err = raw instanceof Error ? raw : new Error(typeof raw === "string" ? raw : "Desktop request failed");
    if (!err.code) err.code = "DESKTOP_IPC_ERROR";
    throw err;
  });
}

/**
 * Window-drag regions. Electron used CSS `-webkit-app-region: drag` on
 * `.titlebar-drag` / `.titlebar-strip` (with no-drag carve-outs for
 * interactive children) — Tauri's webview ignores that property, and its
 * own `data-tauri-drag-region` attribute only fires when the mousedown
 * target IS the tagged element (children swallow it). Reproduce the
 * Electron semantics with event delegation: any mousedown inside a drag
 * region starts a native window drag unless it landed on an interactive
 * element; double-click toggles maximize, mirroring the native titlebar.
 */
const DRAG_REGION_SELECTOR = ".titlebar-drag, .titlebar-strip";
const NO_DRAG_SELECTOR = "button, a, input, textarea, select, [data-no-drag]";

function installDragRegions() {
  const tauri = window.__TAURI__;
  const windowApi = tauri && tauri.window ? tauri.window : null;
  if (!windowApi || typeof windowApi.getCurrentWindow !== "function") return;

  const hitsDragRegion = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (target.closest(NO_DRAG_SELECTOR)) return false;
    return target.closest(DRAG_REGION_SELECTOR) !== null;
  };

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.detail !== 1) return;
    if (!hitsDragRegion(event)) return;
    event.preventDefault();
    windowApi.getCurrentWindow().startDragging().catch((err) => {
      console.warn("[rezDesktop] startDragging failed:", err && err.message ? err.message : err);
    });
  });

  document.addEventListener("dblclick", (event) => {
    if (event.button !== 0) return;
    if (!hitsDragRegion(event)) return;
    event.preventDefault();
    windowApi.getCurrentWindow().toggleMaximize().catch((err) => {
      console.warn("[rezDesktop] toggleMaximize failed:", err && err.message ? err.message : err);
    });
  });
}

function buildUpdatesSurface() {
  // Status events come from the Rust updater (updater.rs); the surface
  // mirrors preload.cjs updates.* exactly.
  const subscribers = new Set();
  const tauri = window.__TAURI__;
  if (tauri && tauri.event && typeof tauri.event.listen === "function") {
    tauri.event.listen("updates:status", (event) => {
      const status = event && event.payload && typeof event.payload === "object" ? event.payload : null;
      if (!status) return;
      for (const handler of [...subscribers]) {
        try {
          handler(status);
        } catch (err) {
          console.warn("[rezDesktop.updates] subscriber threw:", err && err.message ? err.message : err);
        }
      }
    }).catch((err) => {
      console.warn("[rezDesktop.updates] listen failed:", err && err.message ? err.message : err);
    });
  }
  return {
    onStatus(handler) {
      if (typeof handler !== "function") return () => {};
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    getStatus: () => tauriInvoke("updates_get_status"),
    restartAndInstall: () => tauriInvoke("updates_restart_and_install"),
  };
}

/**
 * Web-Notification-compatible wrapper over tauri-plugin-notification.
 * WKWebView/WebKitGTK have no native `Notification`; NotificationService
 * (src/ui/services/bus/NotificationService.js) degrades to silence without
 * one. Covers the surface that service uses: permission, requestPermission,
 * `new Notification(title, {body})`.
 *
 * The plugin is reached through its raw invoke commands
 * (`plugin:notification|…`) — withGlobalTauri only exposes the CORE API on
 * window.__TAURI__; plugin JS bindings live in npm packages we deliberately
 * don't add. Known degradations vs Electron: per-notification icon and
 * onclick focus-thread are not delivered by the plugin — clicks focus the
 * app via the OS default behavior.
 */
/**
 * Bring the app forward natively. The web `window.focus()` the UI calls in
 * its notification click handler is a no-op inside a webview — clicking a
 * banner must raise the actual OS window before the UI selects the thread.
 */
function focusAppWindow() {
  const tauri = window.__TAURI__;
  const windowApi = tauri && tauri.window ? tauri.window : null;
  if (!windowApi || typeof windowApi.getCurrentWindow !== "function") return;
  const current = windowApi.getCurrentWindow();
  Promise.resolve()
    .then(() => current.unminimize())
    .then(() => current.show())
    .then(() => current.setFocus())
    .catch((err) => {
      console.warn("[rezDesktop] focus window failed:", err && err.message ? err.message : err);
    });
}

function installNotificationWrapper() {
  if (typeof window.Notification !== "undefined") return;
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return;
  const invoke = (command, args) => tauri.core.invoke(command, args || {});

  let permissionState = "default";
  invoke("plugin:notification|is_permission_granted").then((granted) => {
    if (granted === true) permissionState = "granted";
  }).catch((err) => {
    console.warn("[rezDesktop] notification permission probe failed:", err && err.message ? err.message : err);
  });

  // One banner at a time: while a banner is plausibly still on screen
  // (macOS banners display for ~5s), additional notifications are dropped —
  // the dock/tray badge still updates, so nothing is lost. An interaction
  // response means the banner is gone and reopens the gate early.
  const BANNER_VISIBLE_MS = 6000;
  let bannerShownAt = 0;

  class RezNotification {
    static get permission() {
      return permissionState;
    }

    static requestPermission() {
      return invoke("plugin:notification|request_permission").then((result) => {
        permissionState = result === "granted" ? "granted" : "denied";
        return permissionState;
      }).catch((err) => {
        console.warn("[rezDesktop] requestPermission failed:", err && err.message ? err.message : err);
        return permissionState;
      });
    }

    constructor(title, options = {}) {
      this.onclick = null;
      // Nonstandard extensions (Tauri shell only), all set by
      // NotificationService and inert on web/Electron:
      //   onreply(text)  inline banner reply  (rezActions: "reply")
      //   onaccept()     Accept button        (rezActions: "accept-reject")
      //   onreject()     Reject button        (rezActions: "accept-reject")
      this.onreply = null;
      this.onaccept = null;
      this.onreject = null;

      const now = Date.now();
      if (now - bannerShownAt < BANNER_VISIBLE_MS) {
        return; // a banner is already up — suppress this one
      }
      bannerShownAt = now;

      const body = options && typeof options.body === "string" ? options.body : "";
      // desktop_notify (notify.rs) renders options.icon — the sender's
      // avatar data: URI, or the Rez mark fallback — as the macOS content
      // image, matching what Chromium did with the web Notification icon.
      const icon = options && typeof options.icon === "string" ? options.icon : "";
      const actions = options && typeof options.rezActions === "string" ? options.rezActions : "";
      invoke("desktop_notify", {
        title: String(title == null ? "" : title),
        body,
        icon,
        actions,
      }).then((response) => {
        if (!response || typeof response !== "object") return;
        if (response.action === "none") {
          // Fire-and-forget posts resolve immediately; the time gate alone
          // decides when the next banner may show.
          return;
        }
        // A real interaction means the banner has left the screen.
        bannerShownAt = 0;
        if (response.action === "click") {
          focusAppWindow();
          if (typeof this.onclick === "function") this.onclick();
          return;
        }
        if (response.action === "reply" && typeof this.onreply === "function") {
          const text = typeof response.text === "string" ? response.text : "";
          this.onreply(text);
          return;
        }
        if (response.action === "accept" && typeof this.onaccept === "function") {
          this.onaccept();
          return;
        }
        if (response.action === "reject" && typeof this.onreject === "function") {
          this.onreject();
        }
      }).catch((err) => {
        console.warn("[rezDesktop] desktop_notify failed:", err && err.message ? err.message : err);
      });
    }

    close() {}
  }

  window.Notification = RezNotification;
}

export function installRezDesktopShim() {
  if (typeof window === "undefined") return false;
  const bootstrap = window.__REZ_TAURI_BOOTSTRAP__;
  if (!bootstrap || typeof bootstrap !== "object") return false;
  if (window.rezDesktop) return false;

  const control = new ControlChannelClient({
    port: Number(bootstrap.shellPort),
    token: String(bootstrap.controlToken || ""),
  });

  // Generic bus event fan-out: ONE control-channel subscription, local
  // per-event filtering — same shape as preload.cjs onBusEvent.
  const busEventSubscribers = new Set();
  control.onEvent("bus:event", (envelope) => {
    if (!envelope || typeof envelope !== "object") return;
    for (const entry of [...busEventSubscribers]) {
      if (entry.name && envelope.event !== entry.name) continue;
      try {
        entry.handler(envelope.payload, envelope);
      } catch (err) {
        console.warn("[rezDesktop.bus] subscriber threw:", err && err.message ? err.message : err);
      }
    }
  });

  const callVault = (channel, params) => unwrap(control.call(channel, params == null ? {} : params));

  window.rezDesktop = {
    platform: String(bootstrap.platform || ""),
    getAppInfo: () => tauriInvoke("desktop_get_app_info"),
    openExternal: (url) => tauriInvoke("desktop_open_external", { url: String(url == null ? "" : url) }),
    generateSigningKeyPair: () => control.call("desktop:generateSigningKeyPair"),
    sign: (options) => control.call("desktop:sign", options),
    verify: (options) => control.call("desktop:verify", options),
    dhGenerateKeyPair: (options) => control.call("desktop:dhGenerateKeyPair", options),
    dhDerive: (options) => control.call("desktop:dhDerive", options),
    scrypt: (opts) => control.call("desktop:scrypt", opts),
    vault: {
      status: () => callVault("desktop:vault:status"),
      createAccount: (params) => callVault("desktop:vault:createAccount", params),
      unlock: (params) => callVault("desktop:vault:unlock", params),
      unlockWithDevice: (params) => callVault("desktop:vault:unlockWithDevice", params),
      disableDeviceUnlock: (params) => callVault("desktop:vault:disableDeviceUnlock", params),
      lock: () => callVault("desktop:vault:lock"),
      listAccounts: () => callVault("desktop:vault:listAccounts"),
      getActiveIdentitySummary: () => callVault("desktop:vault:getActiveIdentitySummary"),
      setProfileName: (params) => callVault("desktop:vault:setProfileName", params),
      setAvatarFileHash: (params) => callVault("desktop:vault:setAvatarFileHash", params),
      getAvatarFileHash: (params) => callVault("desktop:vault:getAvatarFileHash", params),
      setAvatarDataB64: (params) => callVault("desktop:vault:setAvatarDataB64", params),
      getAvatarDataB64: (params) => callVault("desktop:vault:getAvatarDataB64", params),
      revealMnemonic: (params) => callVault("desktop:vault:revealMnemonic", params),
      resetPasswordWithMnemonic: (params) => callVault("desktop:vault:resetPasswordWithMnemonic", params),
      changePassword: (params) => callVault("desktop:vault:changePassword", params),
      exportBackup: (params) => callVault("desktop:vault:exportBackup", params),
      importBackup: (params) => callVault("desktop:vault:importBackup", params),
      purgeAccount: (params) => callVault("desktop:vault:purgeAccount", params),
    },
    backup: {
      saveToFile: (params) => {
        const args = params && typeof params === "object" ? params : {};
        return tauriInvoke("backup_save_to_file", {
          envelope: args.envelope != null ? args.envelope : null,
          suggestedName: typeof args.suggestedName === "string" ? args.suggestedName : null,
        });
      },
      openFile: () => tauriInvoke("backup_open_file"),
    },
    runtime: {
      connect: () => callVault("desktop:runtime:connect"),
      disconnect: () => callVault("desktop:runtime:disconnect"),
      status: () => callVault("desktop:runtime:status"),
    },
    bus: {
      call: (method, params) => unwrap(control.call("bus:call", { method, params: params || {} })),
      on: (eventName, handler) => {
        if (typeof handler !== "function") return () => {};
        const entry = {
          name: String(eventName == null ? "" : eventName).trim(),
          handler,
        };
        busEventSubscribers.add(entry);
        return () => {
          busEventSubscribers.delete(entry);
        };
      },
    },
    updates: buildUpdatesSurface(),
  };

  installDragRegions();
  installNotificationWrapper();
  return true;
}

installRezDesktopShim();
