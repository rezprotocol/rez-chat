import test from "node:test";
import assert from "node:assert/strict";

import { UserEnvironment } from "../src/desktop/runtime/UserEnvironment.js";

function recordingHostChannel(responder) {
  return {
    requests: [],
    async request(op, params) {
      this.requests.push({ op, params });
      return responder(op);
    },
  };
}

test("probes os/arch and host-backed capabilities", async () => {
  const host = recordingHostChannel((op) => {
    if (op === "keychain.probe") return { available: true };
    if (op === "biometric.isAvailable") return { available: false };
    throw new Error("unexpected op " + op);
  });
  const env = new UserEnvironment({ hostChannel: host, logger: { warn() {} } });
  const caps = await env.probe();

  assert.equal(caps.os, process.platform);
  assert.equal(caps.arch, process.arch);
  assert.equal(caps.keychainAvailable, true);
  assert.equal(caps.biometricAvailable, false);
  assert.equal(caps.notificationsAllowed, null);
  // Both host capabilities are probed (no more, no fewer).
  const ops = host.requests.map((r) => r.op).sort();
  assert.deepEqual(ops, ["biometric.isAvailable", "keychain.probe"]);
});

test("caches the probe result — no repeat host calls", async () => {
  const host = recordingHostChannel(() => ({ available: true }));
  const env = new UserEnvironment({ hostChannel: host, logger: { warn() {} } });
  const first = await env.probe();
  const second = await env.probe();
  assert.equal(host.requests.length, 2, "second probe() must reuse the cache");
  assert.equal(first.keychainAvailable, true);
  // capabilities() returns a copy with the same values.
  const snap = env.capabilities();
  assert.equal(snap.keychainAvailable, true);
  assert.equal(snap.biometricAvailable, true);
  assert.equal(second.keychainAvailable, true);
});

test("fails closed when a host capability probe throws", async () => {
  const host = recordingHostChannel((op) => {
    if (op === "keychain.probe") return { available: true };
    throw new Error("biometric subsystem unavailable");
  });
  const env = new UserEnvironment({ hostChannel: host, logger: { warn() {} } });
  const caps = await env.probe();
  assert.equal(caps.keychainAvailable, true);
  assert.equal(caps.biometricAvailable, false);
});

test("reports nothing host-backed when there is no host channel", async () => {
  const env = new UserEnvironment({ hostChannel: null });
  const caps = await env.probe();
  assert.equal(caps.keychainAvailable, false);
  assert.equal(caps.biometricAvailable, false);
  assert.equal(caps.os, process.platform);
});

test("capabilities() before probe() is a fail-closed default", () => {
  const env = new UserEnvironment({ hostChannel: recordingHostChannel(() => ({ available: true })) });
  const caps = env.capabilities();
  assert.equal(caps.keychainAvailable, false);
  assert.equal(caps.biometricAvailable, false);
  assert.equal(caps.notificationsAllowed, null);
});
