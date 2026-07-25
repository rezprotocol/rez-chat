import test from "node:test";
import assert from "node:assert/strict";

import { PendingCeremonyStore } from "../src/server/storage/PendingCeremonyStore.js";
import { PENDING_CEREMONY_STATES } from "../src/records/domain/PendingCeremonyRecordV1.js";

// P1#2a — persist-and-resume ACTIVE registration. A device.add is authoritative the moment the
// leaf is released, so recovery must REPLAY the exact prepared publication (a fresh ceremony mints
// a different certId and never converges). These tests pin the three rules that follow from that.

function makeStorage() {
  const data = new Map();
  const kv = {
    async get(k) { return data.has(k) ? JSON.parse(data.get(k)) : undefined; },
    async set(k, v) { data.set(k, JSON.stringify(v)); },
    async delete(k) { return data.delete(k); },
    async keys(prefix) {
      const out = [];
      for (const k of data.keys()) if (!prefix || k.startsWith(prefix)) out.push(k);
      return out;
    },
  };
  return { provider: { getKeyValueStore: () => kv }, data };
}

const DEVICE = "rez:dev:" + "a".repeat(64);
const CERT = "rez:cap:" + "b".repeat(64);

function fields(overrides = {}) {
  return {
    deviceId: DEVICE,
    inboxId: "inbox:" + "c".repeat(24),
    leafCert: { certId: CERT, granteePublicKeyB64: "grantee", capabilities: ["deviceSet.publish"] },
    certId: CERT,
    sealedResponse: { recordKind: "rez.device-link.response.v1", payloadB64: "c2VhbGVk" },
    thRequestB64: "dGhSZXE=",
    thResponseB64: "dGhSZXNw",
    confirmTagB64: "Y29uZmlybQ==",
    expiresAtMs: 2000,
    ...overrides,
  };
}

function makeStore({ now = 1000 } = {}) {
  const { provider, data } = makeStorage();
  return { store: new PendingCeremonyStore({ storageProvider: provider, clock: () => now }), data };
}

test("createPending persists the exact publication to resume from, in state pending", async () => {
  const { store } = makeStore();
  const rec = await store.createPending(fields());

  assert.equal(rec.state, PENDING_CEREMONY_STATES.PENDING);
  assert.equal(rec.deviceId, DEVICE);
  assert.equal(rec.certId, CERT);
  // The sealed response is what a crash-resume republishes — verbatim.
  assert.deepEqual(rec.sealedResponse, { recordKind: "rez.device-link.response.v1", payloadB64: "c2VhbGVk" });
  assert.deepEqual(rec.leafCert.certId, CERT);
  assert.equal(rec.createdAtMs, 1000);

  const read = await store.get(DEVICE);
  assert.deepEqual(read.toJSON(), rec.toJSON(), "round-trips through the KV unchanged");
});

test("RULE 1 — a second registration for the same device is REFUSED while one is in flight", async () => {
  // Clobbering would orphan the first registration, whose leaf may already be released and whose
  // certId is the only handle for revoking it.
  const { store } = makeStore();
  await store.createPending(fields());
  await assert.rejects(
    () => store.createPending(fields({ certId: "rez:cap:" + "d".repeat(64) })),
    /already has a pending registration — resume or revoke it before starting another/,
  );

  await store.markPublished(DEVICE);
  await assert.rejects(() => store.createPending(fields()), /already has a published registration/);

  // Once terminal, a fresh ceremony for that device is fine.
  await store.markConfirmed(DEVICE);
  const next = await store.createPending(fields({ certId: "rez:cap:" + "e".repeat(64) }));
  assert.equal(next.state, PENDING_CEREMONY_STATES.PENDING);
});

test("RULE 2 — state is forward-only: pending → published → confirmed", async () => {
  const { store } = makeStore();
  await store.createPending(fields());

  assert.equal((await store.markPublished(DEVICE)).state, PENDING_CEREMONY_STATES.PUBLISHED);
  assert.equal((await store.markConfirmed(DEVICE)).state, PENDING_CEREMONY_STATES.CONFIRMED);

  // No going back, and no skipping.
  await assert.rejects(() => store.markPublished(DEVICE), /cannot move device .* from confirmed to published/);
  await assert.rejects(() => store.markExpired(DEVICE), /cannot move device .* from confirmed to expired/);
});

test("RULE 2 — confirming something that was never published is refused", async () => {
  // Confirmation acknowledges a publication. Accepting one for an unpublished registration would
  // record a ceremony as complete while the new device never received its response.
  const { store } = makeStore();
  await store.createPending(fields());
  await assert.rejects(() => store.markConfirmed(DEVICE), /cannot move device .* from pending to confirmed/);
});

test("RULE 2 — transitions on an unknown device fail loudly", async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.markPublished("rez:dev:missing"), /no registration for device/);
});

test("expiry does NOT delete — the record outlives it, because it may still need revoking", async () => {
  const { store, data } = makeStore();
  await store.createPending(fields());
  const expired = await store.markExpired(DEVICE);

  assert.equal(expired.state, PENDING_CEREMONY_STATES.EXPIRED);
  assert.equal(data.size, 1, "still stored");
  const read = await store.get(DEVICE);
  assert.equal(read.certId, CERT, "the certId a compensating revoke needs is still here");
});

test("RULE 3 — deletion requires a COMMITTED revoke naming this registration's cert", async () => {
  const { store, data } = makeStore();
  await store.createPending(fields());
  await store.markExpired(DEVICE);

  await assert.rejects(
    () => store.deleteAfterRevoke(DEVICE, {}),
    /refusing to delete device .* without a committed revoke/,
  );
  await assert.rejects(
    () => store.deleteAfterRevoke(DEVICE, { revokeCommitted: false, revokedCertId: CERT }),
    /without a committed revoke/,
  );
  // A revoke for some OTHER cert must not drop this registration.
  await assert.rejects(
    () => store.deleteAfterRevoke(DEVICE, { revokeCommitted: true, revokedCertId: "rez:cap:" + "f".repeat(64) }),
    /does not name this registration's certId/,
  );
  assert.equal(data.size, 1, "nothing was deleted by any of those");

  assert.equal(await store.deleteAfterRevoke(DEVICE, { revokeCommitted: true, revokedCertId: CERT }), true);
  assert.equal(data.size, 0);
  assert.equal(await store.get(DEVICE), null);
});

test("listResumable returns only registrations that still owe a publication", async () => {
  const { store } = makeStore();
  const other = "rez:dev:" + "9".repeat(64);
  await store.createPending(fields());
  await store.createPending(fields({ deviceId: other, certId: "rez:cap:" + "8".repeat(64) }));

  assert.equal((await store.listResumable()).length, 2, "both are pending");

  // Published means the response reached the rendezvous — no resume work left.
  await store.markPublished(DEVICE);
  const resumable = await store.listResumable();
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0].deviceId, other);
});

test("listExpirable finds pending registrations past their deadline", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 1500 }));

  assert.equal((await store.listExpirable()).length, 0, "not yet past the deadline");
  now = 1600;
  const due = await store.listExpirable();
  assert.equal(due.length, 1);
  assert.equal(due[0].deviceId, DEVICE);

  // Published registrations are never "expirable" — they already did their job.
  await store.markPublished(DEVICE);
  assert.equal((await store.listExpirable()).length, 0);
});

test("a corrupt row THROWS rather than reading as 'no pending registration'", async () => {
  // Absence and corruption must not look alike: reading a damaged row as "nothing pending" would
  // silently drop a registration whose leaf is already live.
  const { provider, data } = makeStorage();
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => 1000 });
  data.set("app:pendingceremony/" + DEVICE, JSON.stringify({ deviceId: DEVICE, state: "pending" }));
  await assert.rejects(() => store.get(DEVICE), /PendingCeremonyRecordV1 requires/);
});

test("the record rejects an unknown state and a missing sealed response", async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.createPending(fields({ sealedResponse: null })),
    /requires the sealed response to resume from/,
  );
});

test("the store requires a storage provider", () => {
  assert.throws(() => new PendingCeremonyStore({}), /requires storageProvider.getKeyValueStore/);
});
