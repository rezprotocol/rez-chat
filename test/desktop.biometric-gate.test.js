import test from "node:test";
import assert from "node:assert/strict";

import {
  BiometricGate,
  BiometricUnavailableError,
  BiometricCancelledError,
} from "../electron/runtime/BiometricGate.mjs";

function macSystemPreferences({ canPrompt = true, shouldResolve = true, error = null } = {}) {
  const calls = [];
  return {
    calls,
    canPromptTouchID() {
      calls.push({ method: "canPromptTouchID" });
      return canPrompt;
    },
    async promptTouchID(reason) {
      calls.push({ method: "promptTouchID", reason });
      if (!shouldResolve) {
        throw error || new Error("User cancelled");
      }
      return undefined;
    },
  };
}

test("BiometricGate macOS happy path prompts and resolves true", async () => {
  const sp = macSystemPreferences({ canPrompt: true, shouldResolve: true });
  const gate = new BiometricGate({ systemPreferences: sp, platform: "darwin" });
  assert.equal(gate.isAvailable(), true);
  const ok = await gate.requireBiometric({ reason: "Unlock Rez" });
  assert.equal(ok, true);
  const promptCall = sp.calls.find((c) => c.method === "promptTouchID");
  assert.equal(promptCall.reason, "Unlock Rez");
});

test("BiometricGate macOS throws BiometricUnavailableError when not enrolled", async () => {
  const sp = macSystemPreferences({ canPrompt: false, shouldResolve: true });
  const gate = new BiometricGate({ systemPreferences: sp, platform: "darwin" });
  assert.equal(gate.isAvailable(), false);
  await assert.rejects(
    () => gate.requireBiometric({ reason: "Unlock Rez" }),
    BiometricUnavailableError,
  );
});

test("BiometricGate macOS throws BiometricCancelledError on user cancel", async () => {
  const sp = macSystemPreferences({ canPrompt: true, shouldResolve: false });
  const gate = new BiometricGate({ systemPreferences: sp, platform: "darwin" });
  await assert.rejects(
    () => gate.requireBiometric({ reason: "Unlock Rez" }),
    BiometricCancelledError,
  );
});

test("BiometricGate uses Windows Hello adapter on win32", async () => {
  const adapter = {
    isAvailable: () => true,
    requestVerification: async () => true,
  };
  const gate = new BiometricGate({ platform: "win32", windowsHelloAdapter: adapter });
  assert.equal(gate.isAvailable(), true);
  assert.equal(await gate.requireBiometric({ reason: "Unlock Rez" }), true);
});

test("BiometricGate Windows throws BiometricUnavailableError when adapter missing", async () => {
  const gate = new BiometricGate({ platform: "win32" });
  assert.equal(gate.isAvailable(), false);
  await assert.rejects(
    () => gate.requireBiometric({ reason: "Unlock Rez" }),
    BiometricUnavailableError,
  );
});

test("BiometricGate Windows throws BiometricCancelledError when adapter returns false", async () => {
  const adapter = {
    isAvailable: () => true,
    requestVerification: async () => false,
  };
  const gate = new BiometricGate({ platform: "win32", windowsHelloAdapter: adapter });
  await assert.rejects(
    () => gate.requireBiometric({ reason: "Unlock Rez" }),
    BiometricCancelledError,
  );
});

test("BiometricGate Linux FAILS CLOSED rather than passing through", async () => {
  // SECURITY_AUDIT MED-18 deliberately replaced the old pass-through `return true` on Linux:
  // there is no portable user-gesture biometric API there, so a silent success handed a free
  // unlock to any caller that used the gate without an upstream safeStorage check. Callers that
  // mean to gate on safeStorage must consult isAvailable() and skip the step explicitly.
  // This test asserted the retired pass-through semantics and was never in the npm test list,
  // so nothing flagged it when the security fix landed.
  const gate = new BiometricGate({ platform: "linux" });
  assert.equal(gate.isAvailable(), false);
  await assert.rejects(
    () => gate.requireBiometric({ reason: "Unlock Rez" }),
    (err) => err.name === "BiometricUnavailableError" && err.code === "BIOMETRIC_UNAVAILABLE",
  );
});
