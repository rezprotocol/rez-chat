import test from "node:test";
import assert from "node:assert/strict";

import { registerDesktopRuntimeIpc } from "../electron/runtime/registerDesktopIpc.mjs";

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
  }

  handle(name, handler) {
    this.handlers.set(name, handler);
  }

  removeHandler(name) {
    this.handlers.delete(name);
  }

  async invoke(name, args = {}) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error("missing handler " + name);
    return handler({}, args);
  }
}

class FakeBusBridge {
  constructor() {
    this.calls = [];
    this.subscribers = new Set();
  }

  async call(method, params) {
    this.calls.push({ method, params });
    return { ok: true, method, params };
  }

  subscribeEvents(emit) {
    this.subscribers.add(emit);
    return () => {
      this.subscribers.delete(emit);
    };
  }

  emitFake(envelope) {
    for (const sub of this.subscribers) sub(envelope);
  }
}

function buildSupervisor({ bridge } = {}) {
  const bb = bridge || new FakeBusBridge();
  return {
    status() {
      return { started: true };
    },
    vaultStatus() {
      return { hasAccounts: false };
    },
    async createAccount(params) {
      return { accountId: params.profileName };
    },
    async unlock() {
      return { accountId: "acct-1" };
    },
    lock() {
      return { locked: true };
    },
    listAccounts() {
      return { accounts: [] };
    },
    getActiveIdentitySummary() {
      return null;
    },
    async connect() {
      return { connected: true };
    },
    async disconnect() {
      return { connected: false };
    },
    getBusBridge() {
      return bb;
    },
    _bridge: bb,
  };
}

test("desktop IPC registers only generic bus + lifecycle channels", () => {
  const ipcMain = new FakeIpcMain();
  const supervisor = buildSupervisor();
  registerDesktopRuntimeIpc({ ipcMain, supervisor, getWindow: () => null });

  const expected = [
    "bus:call",
    "desktop:runtime:connect",
    "desktop:runtime:disconnect",
    "desktop:runtime:status",
    "desktop:vault:changePassword",
    "desktop:vault:createAccount",
    "desktop:vault:disableDeviceUnlock",
    "desktop:vault:exportBackup",
    "desktop:vault:getActiveIdentitySummary",
    "desktop:vault:getAvatarDataB64",
    "desktop:vault:getAvatarFileHash",
    "desktop:vault:importBackup",
    "desktop:vault:listAccounts",
    "desktop:vault:lock",
    "desktop:vault:purgeAccount",
    "desktop:vault:resetPasswordWithMnemonic",
    "desktop:vault:revealMnemonic",
    "desktop:vault:setAvatarDataB64",
    "desktop:vault:setAvatarFileHash",
    "desktop:vault:setProfileName",
    "desktop:vault:status",
    "desktop:vault:unlock",
    "desktop:vault:unlockWithDevice",
  ];
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), expected);
});

test("desktop IPC routes bus:call through DesktopBusBridge.call", async () => {
  const ipcMain = new FakeIpcMain();
  const supervisor = buildSupervisor();
  registerDesktopRuntimeIpc({ ipcMain, supervisor, getWindow: () => null });

  await ipcMain.invoke("desktop:runtime:connect");
  const res = await ipcMain.invoke("bus:call", { method: "invite.create", params: { kind: "direct", maxUses: 1 } });
  assert.deepEqual(res, { ok: true, result: { ok: true, method: "invite.create", params: { kind: "direct", maxUses: 1 } } });
  assert.deepEqual(supervisor._bridge.calls, [{ method: "invite.create", params: { kind: "direct", maxUses: 1 } }]);
});

test("desktop IPC forwards bus events on bus:event channel after connect", async () => {
  const ipcMain = new FakeIpcMain();
  const supervisor = buildSupervisor();
  const sent = [];
  const win = {
    webContents: {
      send(name, payload) {
        sent.push([name, payload]);
      },
    },
  };
  registerDesktopRuntimeIpc({ ipcMain, supervisor, getWindow: () => win });

  // Before connect, no subscription is attached.
  supervisor._bridge.emitFake({ event: "peer-link.updated", payload: { state: "session_established" } });
  assert.equal(sent.length, 0);

  await ipcMain.invoke("desktop:runtime:connect");
  supervisor._bridge.emitFake({ event: "peer-link.updated", payload: { state: "session_established" } });
  assert.deepEqual(sent, [["bus:event", { event: "peer-link.updated", payload: { state: "session_established" } }]]);
});

test("desktop IPC detaches event subscription on disconnect", async () => {
  const ipcMain = new FakeIpcMain();
  const supervisor = buildSupervisor();
  const sent = [];
  const win = {
    webContents: {
      send(name, payload) {
        sent.push([name, payload]);
      },
    },
  };
  registerDesktopRuntimeIpc({ ipcMain, supervisor, getWindow: () => win });

  await ipcMain.invoke("desktop:runtime:connect");
  await ipcMain.invoke("desktop:runtime:disconnect");
  supervisor._bridge.emitFake({ event: "peer-link.updated", payload: {} });
  assert.equal(sent.length, 0);
});

test("desktop IPC wraps supervisor failures without throwing across bridge", async () => {
  const ipcMain = new FakeIpcMain();
  const supervisor = buildSupervisor();
  supervisor.vaultStatus = () => { throw new Error("boom"); };
  registerDesktopRuntimeIpc({ ipcMain, supervisor });

  const result = await ipcMain.invoke("desktop:vault:status");
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "boom");
});
