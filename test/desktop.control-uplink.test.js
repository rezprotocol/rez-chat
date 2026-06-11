import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket from "ws";

import { DesktopControlUplink } from "../src/desktop/transport/DesktopControlUplink.js";
import { encodeControlValue, decodeControlValue } from "../src/desktop/transport/ControlFrameCodec.js";
import { registerDesktopRuntimeIpc } from "../src/desktop/runtime/registerDesktopIpc.js";
import { registerDesktopCryptoChannels } from "../src/desktop/runtime/registerDesktopCryptoChannels.js";

const CONTROL_TOKEN = "test-control-token";

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

/**
 * Minimal control-channel client mirroring what the webview shim does:
 * hello handshake, id-correlated calls, event collection.
 */
class TestControlClient {
  constructor(port, { token = CONTROL_TOKEN, origin = undefined } = {}) {
    this.ws = new WebSocket("ws://127.0.0.1:" + port + "/control", { origin });
    this.events = [];
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
    });
    this.helloOk = new Promise((resolve, reject) => {
      this._helloResolve = resolve;
      this.ws.on("error", reject);
    });
    this._pending = new Map();
    this._nextId = 1;
    this._token = token;
    this.ws.on("open", () => {
      this.ws.send(JSON.stringify({ op: "hello", controlToken: this._token }));
    });
    this.ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.op === "hello.ok") {
        this._helloResolve(true);
        return;
      }
      if (frame.op === "result") {
        const pending = this._pending.get(frame.id);
        if (pending) {
          this._pending.delete(frame.id);
          pending(frame);
        }
        return;
      }
      if (frame.op === "event") {
        this.events.push({ channel: frame.channel, payload: decodeControlValue(frame.payload) });
      }
    });
  }

  call(channel, args = {}) {
    const id = String(this._nextId);
    this._nextId += 1;
    return new Promise((resolve) => {
      this._pending.set(id, resolve);
      this.ws.send(JSON.stringify({ op: "call", id, channel, args: encodeControlValue(args) }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function startUplink({ supervisor = buildSupervisor(), allowedOrigins = [], crypto = null } = {}) {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const uplink = new DesktopControlUplink({
    server,
    controlToken: CONTROL_TOKEN,
    allowedOrigins,
    logger: { warn() {} },
  });
  registerDesktopRuntimeIpc({
    ipcMain: uplink.ipcRegistry,
    supervisor,
    getWindow: () => uplink.windowAdapter,
  });
  if (crypto) {
    registerDesktopCryptoChannels({ ipcMain: uplink.ipcRegistry, crypto });
  }
  uplink.start();
  const stop = async () => {
    await uplink.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return { uplink, supervisor, port, stop };
}

test("control uplink: hello with valid token gets hello.ok; calls flow", async () => {
  const { supervisor, port, stop } = await startUplink();
  const client = new TestControlClient(port);
  await client.helloOk;

  const status = await client.call("desktop:vault:status");
  assert.equal(status.ok, true);
  assert.deepEqual(status.payload, { ok: true, result: { hasAccounts: false } });

  await client.call("desktop:runtime:connect");
  const res = await client.call("bus:call", { method: "invite.create", params: { kind: "direct", maxUses: 1 } });
  assert.deepEqual(res.payload, { ok: true, result: { ok: true, method: "invite.create", params: { kind: "direct", maxUses: 1 } } });
  assert.deepEqual(supervisor._bridge.calls, [{ method: "invite.create", params: { kind: "direct", maxUses: 1 } }]);

  client.close();
  await stop();
});

test("control uplink: wrong token closes the socket with 4401", async () => {
  const { port, stop } = await startUplink();
  const client = new TestControlClient(port, { token: "wrong-token" });
  const closed = await client.closed;
  assert.equal(closed.code, 4401);
  await stop();
});

test("control uplink: call before hello closes the socket", async () => {
  const { port, stop } = await startUplink();
  const ws = new WebSocket("ws://127.0.0.1:" + port + "/control");
  const closed = new Promise((resolve) => {
    ws.on("close", (code) => resolve(code));
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({ op: "call", id: "1", channel: "desktop:vault:status", args: {} }));
  });
  assert.equal(await closed, 4401);
  await stop();
});

test("control uplink: disallowed origin is rejected at upgrade", async () => {
  const { port, stop } = await startUplink({ allowedOrigins: ["tauri://localhost"] });

  const rejected = new WebSocket("ws://127.0.0.1:" + port + "/control", { origin: "https://evil.example" });
  const rejectedOutcome = await new Promise((resolve) => {
    rejected.on("error", () => resolve("error"));
    rejected.on("open", () => resolve("open"));
  });
  assert.equal(rejectedOutcome, "error");

  const allowed = new TestControlClient(port, { origin: "tauri://localhost" });
  await allowed.helloOk;
  allowed.close();
  await stop();
});

test("control uplink: bus events broadcast after connect, stop after disconnect", async () => {
  const { supervisor, port, stop } = await startUplink();
  const client = new TestControlClient(port);
  await client.helloOk;

  supervisor._bridge.emitFake({ event: "peer-link.updated", payload: { state: "early" } });
  await client.call("desktop:runtime:connect");
  supervisor._bridge.emitFake({ event: "peer-link.updated", payload: { state: "session_established" } });
  // Round-trip a call so the event frame is guaranteed delivered first.
  await client.call("desktop:runtime:status");
  assert.deepEqual(client.events, [
    { channel: "bus:event", payload: { event: "peer-link.updated", payload: { state: "session_established" } } },
  ]);

  await client.call("desktop:runtime:disconnect");
  supervisor._bridge.emitFake({ event: "peer-link.updated", payload: { state: "late" } });
  await client.call("desktop:runtime:status");
  assert.equal(client.events.length, 1);

  client.close();
  await stop();
});

test("control uplink: handler errors come back as ok:false envelopes", async () => {
  const supervisor = buildSupervisor();
  supervisor.vaultStatus = () => {
    throw new Error("boom");
  };
  const { port, stop } = await startUplink({ supervisor });
  const client = new TestControlClient(port);
  await client.helloOk;

  const res = await client.call("desktop:vault:status");
  // registerDesktopIpc wraps handler failures itself, so the op-level frame
  // succeeds and the envelope carries the error — same as Electron IPC.
  assert.equal(res.ok, true);
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.message, "boom");

  client.close();
  await stop();
});

test("control uplink: unknown channel yields UNKNOWN_CHANNEL error", async () => {
  const { port, stop } = await startUplink();
  const client = new TestControlClient(port);
  await client.helloOk;

  const res = await client.call("desktop:nope");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "UNKNOWN_CHANNEL");

  client.close();
  await stop();
});

test("control uplink: crypto channels return raw values with byte-codec round-trip", async () => {
  const fakeCrypto = {
    generateSigningKeyPair() {
      return { publicKey: "pub", privateKey: "priv" };
    },
    sign(options) {
      return { signature: new Uint8Array([7, 8, 9]), over: options.payload };
    },
    verify() {
      return true;
    },
    dhGenerateKeyPair() {
      return {};
    },
    dhDerive() {
      return {};
    },
  };
  const { port, stop } = await startUplink({ crypto: fakeCrypto });
  const client = new TestControlClient(port);
  await client.helloOk;

  const keys = await client.call("desktop:generateSigningKeyPair");
  assert.deepEqual(keys.payload, { publicKey: "pub", privateKey: "priv" });

  const signed = await client.call("desktop:sign", { payload: new Uint8Array([1, 2, 3]) });
  assert.equal(signed.ok, true);
  const decoded = decodeControlValue(signed.payload);
  assert.deepEqual(decoded.signature, new Uint8Array([7, 8, 9]));
  assert.deepEqual(decoded.over, new Uint8Array([1, 2, 3]));

  // scrypt: throwing handler surfaces as op-level error (raw semantics).
  const scryptErr = await client.call("desktop:scrypt", { password: "" });
  assert.equal(scryptErr.ok, false);
  assert.match(scryptErr.error.message, /password required/);

  client.close();
  await stop();
});

test("control frame codec: nested byte arrays round-trip; reserved key rejected", () => {
  const value = {
    list: [new Uint8Array([1]), { deep: new Uint8Array([2, 3]) }],
    text: "plain",
    num: 42,
    none: null,
  };
  const decoded = decodeControlValue(JSON.parse(JSON.stringify(encodeControlValue(value))));
  assert.deepEqual(decoded.list[0], new Uint8Array([1]));
  assert.deepEqual(decoded.list[1].deep, new Uint8Array([2, 3]));
  assert.equal(decoded.text, "plain");
  assert.equal(decoded.num, 42);
  assert.equal(decoded.none, null);

  assert.throws(() => encodeControlValue({ $rezU8: "sneaky" }), /reserved key/);
});
