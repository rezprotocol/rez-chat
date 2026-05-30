/**
 * Bus-driven entry: boots the class-based ChatApp and scene host directly.
 */
import "./styles/fonts.css";
import "./styles/tailwind.css";
import "rez-ui/framework/theme.css";
import "./ui/styles.css";
import { ChatRuntimeConfig } from "./ui/records/ChatRuntimeConfig.js";
import { ChatRuntimeClient } from "./client/runtime/ChatRuntimeClient.js";
import { DesktopRuntimeClient } from "./client/runtime/DesktopRuntimeClient.js";
import { ChatApp } from "./ui/root/ChatApp.js";

function safeRuntimeConfig(raw) {
  // globalThis / /config endpoint are untrusted sources — catch+log+fallback
  // to default config so the app boots.
  try {
    return new ChatRuntimeConfig(raw);
  } catch (err) {
    console.warn("[main] invalid runtime config, falling back:", err && err.message ? err.message : err);
    return new ChatRuntimeConfig({ uplinks: [], warmSpareCount: 2, features: { chatBackupV1: false } });
  }
}

async function loadRuntimeConfig() {
  const shellGlobal = safeRuntimeConfig(globalThis.__REZ_SHELL_CONFIG__ || globalThis.REZ_CONFIG || {});
  if (shellGlobal.uplinks.length > 0) return shellGlobal;
  if (typeof globalThis.fetch === "function") {
    try {
      const res = await globalThis.fetch("/config", { cache: "no-store" });
      if (res.ok) {
        const payload = await res.json().catch(() => ({}));
        const next = safeRuntimeConfig(payload);
        if (next.uplinks.length > 0) return next;
      }
    } catch {
      // no-op
    }
  }
  return new ChatRuntimeConfig({ uplinks: [], warmSpareCount: 2, features: { chatBackupV1: false } });
}

const mountEl = document.getElementById("app");
if (!mountEl) throw new Error("Missing #app root element");

const config = await loadRuntimeConfig();
globalThis.__REZ_RUNTIME_CONFIG__ = config;

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/ws`;

const bridgeToken = config && typeof config.bridgeToken === "string" ? config.bridgeToken : "";
const desktopBridge = window && window.rezDesktop && window.rezDesktop.runtime
  && window.rezDesktop.bus && typeof window.rezDesktop.bus.call === "function"
  ? window.rezDesktop
  : null;

const sdkFactory = ({ account } = {}) => new ChatRuntimeClient({
  wsUrl,
  accountId: account && account.accountId ? String(account.accountId).trim() : null,
  deviceId: account && account.deviceId ? String(account.deviceId).trim() : null,
  bridgeToken,
});
const desktopSdkFactory = () => new DesktopRuntimeClient({ desktop: desktopBridge });

const app = new ChatApp({
  mountEl,
  theme: {},
  sdkFactory: desktopBridge ? desktopSdkFactory : sdkFactory,
  logger: console,
});
await app.start();
