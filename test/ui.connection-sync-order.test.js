import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionStore } from "../src/ui/stores/ConnectionStore.js";
import { ConnectionService } from "../src/ui/services/bus/ConnectionService.js";

test("sync completion survives the final connect notification and resets for a new connection", () => {
  const listeners = new Map();
  const bus = {
    registerFunction() {},
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    emit(name, value) { const handler = listeners.get(name); if (handler) handler(value); },
  };
  const store = new ConnectionStore({ bus });
  new ConnectionService({ bus, connectionStore: store });
  bus.emit("runtime.connecting", {});
  bus.emit("runtime.event.inbox.caughtup", {});
  bus.emit("runtime.connected", {});
  assert.equal(store.isInboxSynced(), true);
  bus.emit("runtime.event.connection.state", { status: "connecting" });
  assert.equal(store.isInboxSynced(), false);
  bus.emit("runtime.connected", {});
  assert.equal(store.isInboxSynced(), false, "transport readiness cannot fabricate catch-up completion");
  bus.emit("runtime.event.inbox.caughtup", {});
  bus.emit("runtime.disconnected", {});
  assert.equal(store.isInboxSynced(), false);
});
