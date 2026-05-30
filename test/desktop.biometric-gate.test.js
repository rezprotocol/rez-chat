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

test("BiometricGate Linux passes through without prompting", async () => {
  const gate = new BiometricGate({ platform: "linux" });
  assert.equal(gate.isAvailable(), false);
  assert.equal(await gate.requireBiometric({ reason: "Unlock Rez" }), true);
});
