// M6 client policy (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §7e) — re-mint on
// PROVIDER EVIDENCE only, at the bind seam, over the REAL sdk InboxClaimStore:
//   INBOX_CLOSED + detail{closeReason:"reclaimed", finalGeneration == stored}
//     → re-mint (gen+1, same claimant key, fresh close key), ONE retry,
//       and the DISTINCT `mailbox.remint` event (never "renewed").
//   "terminal" → rethrow, never re-mint.
//   finalGeneration mismatch → REMINT_GENERATION_CONFLICT surfaces.
//   detail missing (legacy provider) → rethrow, never guess.

import test from "node:test";
import assert from "node:assert/strict";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { bytesToBase64, nodeKeyIdForNodePublicKeyB64, relayKeyIdForNodePublicKeyB64 } from "@rezprotocol/core";
import { InboxClaimStore } from "@rezprotocol/sdk/client";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { ServerRuntimeService } from "../src/server/services/ServerRuntimeService.js";

const CRYPTO = new NodeCryptoProvider();
const QUIET = { log() {}, warn() {}, info() {}, error() {} };

// The REAL claim store validates the relay identity binding when signing a
// node delegation, so the fake node needs a self-consistent identity.
const NODE_IDENTITY = (() => {
  const kp = CRYPTO.generateSigningKeyPair();
  const nodePublicKeyB64 = bytesToBase64(kp.publicKey);
  return {
    nodeKeyId: nodeKeyIdForNodePublicKeyB64(nodePublicKeyB64),
    nodePublicKeyB64,
    relayKeyId: relayKeyIdForNodePublicKeyB64(nodePublicKeyB64),
  };
})();

class MemKv {
  #m = new Map();
  async get(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  async set(k, v) { this.#m.set(k, v); }
  async delete(k) { this.#m.delete(k); }
}
class MemStorage {
  #kv = new MemKv();
  getKeyValueStore() { return this.#kv; }
}

function inboxClosedErr({ closeReason, finalGeneration } = {}) {
  const err = new Error("inbox closed");
  err.code = "INBOX_CLOSED";
  err.retryable = false;
  if (closeReason !== undefined) {
    err.detail = { closeReason, finalGeneration };
  }
  return err;
}

// Fake sdk whose INBOX_CLAIM answers are scripted per call.
function makeSdk(claimAnswers) {
  const claims = [];
  return {
    claims,
    async connect() {},
    async close() {},
    connectivity: { onReconnected() { return () => {}; } },
    getSessionInfo() {
      return { ...NODE_IDENTITY, capabilities: {} };
    },
    async sendRequest(req) {
      claims.push(req.body);
      const answer = claimAnswers.shift();
      if (answer instanceof Error) throw answer;
      return { body: {} };
    },
    subscriptions: { onMailboxDeposited() { return () => {}; } },
    mailbox: { async ack() {} },
  };
}

async function makeStoreWithClaim() {
  const store = new InboxClaimStore({ storageProvider: new MemStorage(), cryptoProvider: CRYPTO });
  await store.hydrate();
  const claim = await store.createClaim();
  await store.persist(claim);
  return { store, inboxId: claim.inboxId };
}

async function makeRuntime({ sdk, store, inboxId }) {
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  bus.services.inboundPipeline = { submit: async () => ({ status: "noop" }) };
  const events = [];
  bus.on("mailbox.remint", (e) => events.push(e));
  const svc = new ServerRuntimeService({
    bus,
    identity: { accountId: "rez:acct:m6", deviceId: "dev:m6", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://node"],
    sdk,
    inboxClaimant: { inboxId, claimStore: store },
    logger: QUIET,
  });
  return { svc, bus, events };
}

test("M6: reclaimed refusal with matching finalGeneration → re-mint gen+1 (fresh close key, same claimant key), ONE retry, distinct mailbox.remint event", async () => {
  const { store, inboxId } = await makeStoreWithClaim();
  const before = store.get(inboxId);
  const sdk = makeSdk([inboxClosedErr({ closeReason: "reclaimed", finalGeneration: 1 })]); // then accept
  const { svc, events } = await makeRuntime({ sdk, store, inboxId });

  await svc.connect();

  assert.equal(sdk.claims.length, 2, "refused once, re-minted, retried once");
  assert.equal(sdk.claims[1].generation, 2, "the retry claims generation 2");
  const after = store.get(inboxId);
  assert.equal(after.generation, 2);
  assert.equal(after.claimantPublicKeyB64, before.claimantPublicKeyB64, "claimant key survives — peers' bindings stay valid");
  assert.notEqual(after.closePublicKeyB64, before.closePublicKeyB64, "fresh close key — the dead lifetime's kill switch is gone");
  assert.deepEqual(events, [{ inboxId, fromGeneration: 1, toGeneration: 2 }],
    "the DISTINCT re-mint event fired (address recovered, buffered mail may be gone — never a 'renewed')");
  assert.ok(store.leaseState(inboxId), "the accepted retry recorded the fresh lease");
});

test("M6: terminal refusal NEVER re-mints — rethrown, generation untouched, no event", async () => {
  const { store, inboxId } = await makeStoreWithClaim();
  const sdk = makeSdk([inboxClosedErr({ closeReason: "terminal", finalGeneration: 1 })]);
  const { svc, events } = await makeRuntime({ sdk, store, inboxId });

  await assert.rejects(svc.connect(), (err) => err.code === "INBOX_CLOSED");
  assert.equal(sdk.claims.length, 1, "no retry");
  assert.equal(store.get(inboxId).generation, 1, "generation untouched");
  assert.deepEqual(events, []);
});

test("M6: finalGeneration mismatch → REMINT_GENERATION_CONFLICT surfaces; nothing mutated, no retry loop", async () => {
  const { store, inboxId } = await makeStoreWithClaim();
  const sdk = makeSdk([inboxClosedErr({ closeReason: "reclaimed", finalGeneration: 4 })]);
  const { svc, events } = await makeRuntime({ sdk, store, inboxId });

  await assert.rejects(svc.connect(), (err) => err.code === "REMINT_GENERATION_CONFLICT");
  assert.equal(sdk.claims.length, 1);
  assert.equal(store.get(inboxId).generation, 1);
  assert.deepEqual(events, []);
});

test("M6: INBOX_CLOSED with NO typed detail (legacy provider) → rethrown, never local arithmetic", async () => {
  const { store, inboxId } = await makeStoreWithClaim();
  const sdk = makeSdk([inboxClosedErr({})]); // detail absent entirely
  const { svc, events } = await makeRuntime({ sdk, store, inboxId });

  await assert.rejects(svc.connect(), (err) => err.code === "INBOX_CLOSED");
  assert.equal(store.get(inboxId).generation, 1);
  assert.deepEqual(events, []);
});

test("M6: a SECOND reclaimed refusal after a successful re-mint is a real fault — single retry, no loop", async () => {
  const { store, inboxId } = await makeStoreWithClaim();
  const sdk = makeSdk([
    inboxClosedErr({ closeReason: "reclaimed", finalGeneration: 1 }),
    inboxClosedErr({ closeReason: "reclaimed", finalGeneration: 2 }),
    inboxClosedErr({ closeReason: "reclaimed", finalGeneration: 3 }),
  ]);
  const { svc } = await makeRuntime({ sdk, store, inboxId });

  await assert.rejects(svc.connect(), (err) => err.code === "INBOX_CLOSED");
  assert.equal(sdk.claims.length, 2, "exactly one re-mint retry — never increment-until-it-works");
  assert.equal(store.get(inboxId).generation, 2, "one re-mint happened, then the fault surfaced");
});
