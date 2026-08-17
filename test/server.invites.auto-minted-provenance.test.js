import test from "node:test";
import assert from "node:assert/strict";

import { ServerInvitesService } from "../src/server/services/ServerInvitesService.js";
import { AutoMintedInviteStore } from "../src/server/storage/AutoMintedInviteStore.js";
import { AutoMintedInvite } from "../src/records/domain/AutoMintedInvite.js";

/**
 * rez-chat#10 / GHSA-pqxm-v42c-xr8f regression pins.
 *
 * Peer-link recovery re-uses the invite/accept path, and the same mechanism
 * serves both "heal a desynced DM link" and "bootstrap a co-member transport
 * link". Every such invite is minted kind:"direct" because the wire admits only
 * {direct, group}. ServerEventService then asks isDirectContactInvite() whether
 * the established link should become VISIBLE — and for a co-member link the
 * honest-but-wrong answer "yes" surfaces two people who merely share a group as
 * a 1:1 contact + DM thread.
 *
 * The in-memory allow-list already gets this right, so the defect only appears
 * once that list is gone — i.e. after a restart, when the durable envelope
 * fallback takes over. THE RESTART IS THE TEST. A fixture that leaves the
 * allow-list populated passes against the buggy code and proves nothing.
 */

const OWNER = "rez:acct:invites-owner";

// Minimal in-memory KV with the get/set/keys/delete surface KvTable requires.
function makeStorageProvider() {
  const rows = new Map();
  const kv = {
    async get(key) {
      const raw = rows.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async set(key, value) { rows.set(key, JSON.stringify(value)); },
    async delete(key) { rows.delete(key); },
    async keys(prefix) {
      const out = [];
      for (const key of rows.keys()) if (key.startsWith(prefix)) out.push(key);
      return out;
    },
  };
  return { getKeyValueStore: () => kv, _rows: rows };
}

// A chat-server whose PROCESS has restarted: durable stores survive, the
// service's in-memory allow-list does not.
function makeService({ storageProvider, storedEnvelopes = new Map(), autoMintedStore = undefined }) {
  const emitted = [];
  const errors = [];
  const logger = {
    log() {}, info() {}, debug() {}, warn() {},
    error(...args) { errors.push(args.map(String).join(" ")); },
  };
  const store = autoMintedStore === undefined
    ? new AutoMintedInviteStore({ storageProvider })
    : autoMintedStore;
  const bus = {
    emit(name, payload) { emitted.push({ name, payload }); },
    registerFunction() {},
    stores: { autoMintedInviteStore: store },
    runtime: {
      peerLinks: {
        ownerAccountId: OWNER,
        async getStoredInviteEnvelope(owner, inviteId) {
          const envelope = storedEnvelopes.get(inviteId);
          return envelope ? { envelope } : null;
        },
      },
    },
  };
  const svc = new ServerInvitesService({ bus, logger });
  return { svc, emitted, errors, store };
}

test("AutoMintedInvite requires an inviteId and defaults its reason", () => {
  assert.throws(() => new AutoMintedInvite({}).validate(), /requires inviteId/);
  const row = new AutoMintedInvite({ inviteId: "plinv_x" });
  assert.equal(row.reason, "unspecified");
  assert.equal(row.expiresAtMs, row.createdAtMs);
});

test("a recovery invite does NOT read as a direct contact invite after a restart", async () => {
  const storageProvider = makeStorageProvider();
  // Pre-restart: the recovery path minted the invite and recorded provenance.
  const store = new AutoMintedInviteStore({ storageProvider });
  await store.markAutoMinted({
    ownerAccountId: OWNER,
    inviteId: "plinv_recovery",
    reason: "peerlink-recovery",
    expiresAtMs: Date.now() + 300_000,
  });

  // Post-restart: fresh service (empty allow-list); the envelope on disk says
  // kind:"direct", because that is all the wire can express.
  const envelopes = new Map([["plinv_recovery", { kind: "direct" }]]);
  const { svc } = makeService({ storageProvider, storedEnvelopes: envelopes });

  assert.equal(
    await svc.isDirectContactInvite("plinv_recovery"),
    false,
    "an auto-minted recovery invite must never surface a 1:1 contact, whatever its envelope kind says",
  );
});

test("a genuine direct invite STILL materializes after a restart", async () => {
  // The regression guard for the fix itself. The envelope fallback exists so an
  // invite a user minted before closing the app still works when the peer
  // finally accepts; the deny-list must not break that.
  const storageProvider = makeStorageProvider();
  const envelopes = new Map([["plinv_human", { kind: "direct" }]]);
  const { svc } = makeService({ storageProvider, storedEnvelopes: envelopes });

  assert.equal(
    await svc.isDirectContactInvite("plinv_human"),
    true,
    "a human-minted direct invite must still materialize across a restart",
  );
});

test("a group invite still reads false", async () => {
  const storageProvider = makeStorageProvider();
  const envelopes = new Map([["plinv_group", { kind: "group", groupId: "grp_1" }]]);
  const { svc } = makeService({ storageProvider, storedEnvelopes: envelopes });
  assert.equal(await svc.isDirectContactInvite("plinv_group"), false);
});

test("provenance survives expiry — a late accept is still refused", async () => {
  // expiresAtMs is storage hygiene, never an authorization input. An expired
  // row still proves WE minted the invite.
  const storageProvider = makeStorageProvider();
  const store = new AutoMintedInviteStore({ storageProvider });
  await store.markAutoMinted({
    ownerAccountId: OWNER,
    inviteId: "plinv_stale",
    reason: "peerlink-recovery",
    expiresAtMs: Date.now() - 60_000,
  });
  const envelopes = new Map([["plinv_stale", { kind: "direct" }]]);
  const { svc } = makeService({ storageProvider, storedEnvelopes: envelopes });

  assert.equal(await svc.isDirectContactInvite("plinv_stale"), false);
});

test("a storage fault fails CLOSED and is reported, not swallowed", async () => {
  const storageProvider = makeStorageProvider();
  const exploding = {
    async isAutoMinted() { throw new Error("kv exploded"); },
  };
  const envelopes = new Map([["plinv_any", { kind: "direct" }]]);
  const { svc, emitted, errors } = makeService({
    storageProvider,
    storedEnvelopes: envelopes,
    autoMintedStore: exploding,
  });

  assert.equal(
    await svc.isDirectContactInvite("plinv_any"),
    false,
    "unable to prove human intent => must not materialize",
  );
  assert.ok(errors.some((line) => line.includes("auto-minted lookup failed")), "must log the fault");
  assert.ok(
    emitted.some((e) => e.name === "app.error"),
    "must raise app.error so the fault is visible, not silently degraded",
  );
});

test("isAutoMinted throws (rather than reporting false) when storage read fails", async () => {
  const storageProvider = makeStorageProvider();
  const store = new AutoMintedInviteStore({ storageProvider });
  store.invites.get = async () => { throw new Error("disk gone"); };
  await assert.rejects(
    () => store.isAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_x" }),
    /failing closed/,
    "absence must never be inferred from a fault",
  );
});

test("an EXPIRED invite's provenance is NOT pruned — retention runs off mint time", async () => {
  // The trap this fix must not fall into: sweeping rows at invite-expiry turns
  // expiry into an authorization input, and a late accept re-reads as
  // human-minted. Writing a second row triggers a prune pass; the expired-invite
  // row must survive it.
  const storageProvider = makeStorageProvider();
  const store = new AutoMintedInviteStore({ storageProvider });
  const now = Date.now();
  await store.markAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_expired", expiresAtMs: now - 60_000 });
  await store.markAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_live", expiresAtMs: now + 300_000 });

  assert.equal(await store.isAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_expired" }), true);
  assert.equal(await store.isAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_live" }), true);
});

test("rows older than the retention window ARE pruned", async () => {
  const storageProvider = makeStorageProvider();
  let nowMs = Date.now();
  const store = new AutoMintedInviteStore({ storageProvider, clock: () => nowMs });
  await store.markAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_ancient" });

  nowMs += 25 * 60 * 60 * 1000; // past the 24h retention window
  await store.markAutoMinted({ ownerAccountId: OWNER, inviteId: "plinv_fresh" });

  const remaining = await store.invites.list(OWNER);
  assert.deepEqual(remaining.map((r) => r.inviteId), ["plinv_fresh"]);
});
