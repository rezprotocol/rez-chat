import { MobileHostRequestV1 } from "./MobileHostRecords.js";
import { MOBILE_VAULT_METHODS } from "./MobileHostSpec.js";
import { MobileShareFileV1, MobileShareResultV1 } from "./MobileFileRecords.js";

// Compatibility with the existing native-host UI contract. The shared UI's
// historical name is rezDesktop; both names below refer to ONE bridge object.
// No keys or protocol state enter the WebView.
if (globalThis.__REZ_MOBILE__ === true) {
  const listeners = new Map();
  const invoke = globalThis.__TAURI__.core.invoke;
  let sequence = 0;
  const channel = new globalThis.__TAURI__.core.Channel();
  channel.onmessage = (json) => {
    const event = JSON.parse(json);
    const handlers = listeners.get(event.event);
    if (handlers) for (const handler of Array.from(handlers)) handler(JSON.parse(event.payloadJson));
  };
  const ready = invoke("plugin:rez-native|subscribe", { channel });
  async function call(operation, params = {}) {
    await ready;
    const request = new MobileHostRequestV1({ id: "mobile:" + (++sequence), operation, paramsJson: JSON.stringify(params) });
    const raw = await invoke("plugin:rez-native|dispatch", { request: JSON.stringify(request.toJSON()) });
    const response = JSON.parse(raw);
    if (response.id !== request.id) throw new Error("Mobile response identity mismatch");
    if (!response.ok) { const error = new Error(response.error || "Mobile operation failed"); error.code = response.code; throw error; }
    return JSON.parse(response.resultJson);
  }
  const vault = Object.fromEntries(MOBILE_VAULT_METHODS.map((name) => [name, (params) => call("vault." + name, params)]));
  const bus = {
    call: (method, params) => call("bus:" + method, params),
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
  };
  const files = {
    share: async (params) => {
      const request = new MobileShareFileV1(params);
      return new MobileShareResultV1(await invoke("plugin:rez-native|shareFile", { request: JSON.stringify(request.toJSON()) }));
    },
  };
  const bridge = { platform: "ios", vault, bus, files, runtime: { connect: () => call("runtime.connect"), disconnect: () => call("runtime.disconnect") } };
  globalThis.rezMobile = bridge;
  globalThis.rezDesktop = bridge;
}
