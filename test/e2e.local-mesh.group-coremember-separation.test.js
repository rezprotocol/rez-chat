import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh SEPARATION-INVARIANT e2e — fully un-mocked, loopback only.
 *
 * Reproduces the reported dev:three bug: Bob founds a group, Bob has REAL direct
 * contacts with BOTH Alice and Carol, and all three are group members. Alice and
 * Carol are co-members but never directly invited each other.
 *
 * STRICT contacts/groups separation: group co-membership must NEVER create a 1:1
 * contact or DM thread. The co-member mesh (Alice↔Carol bootstrap link) is pure
 * transport — it must establish INVISIBLY. The bug: it materializes a "Connected"
 * direct thread + an unnamed contact on both Alice and Carol.
 *
 * This asserts:
 *   - POSITIVE control: Bob↔Alice and Bob↔Carol ARE real contacts + DM threads
 *     (they exchanged a direct invite).
 *   - INVARIANT: Alice has NO direct contact / NO direct thread for Carol, and
 *     vice-versa — even though their transport link is established.
 *   - NAME: Carol resolves by name in Alice's roster (and Alice in Carol's),
 *     proving the name propagates without a contact.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const CHAT_TIMEOUT_MS = 45_000;

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const knownRelay = (relayKeyId, port) => ({
  id: relayKeyId, relayKeyId, host: "127.0.0.1", port, transport: "tcp", insecure: true, tls: false,
});

function relayOnlyConfig({ dataDir, listenPort, relayKeyId, knownRelays }) {
  return {
    node: {
      mode: "relay-only",
      storage: { dataDir },
      network: { knownRelays },
      mesh: { mode: "seed-only", seeds: [] },
      relay: { listenHost: "127.0.0.1", listenPort, advertisedHost: "127.0.0.1", relayKeyId },
    },
  };
}

async function startChatLeaf({ tmp, label, entryRelayKeyId, entryRelayPort }) {
  const dataDir = path.join(tmp, label);
  await fs.mkdir(dataDir, { recursive: true });
  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays: [knownRelay(entryRelayKeyId, entryRelayPort)] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5 },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  const wsUrl = "ws://127.0.0.1:" + wsPort + wsPath;
  const bootstrapped = await bootstrapChatServer({ nodeDataDir: dataDir, wsUrl, logger: silentLogger });
  await bootstrapped.chatServer.start();
  return { label, nodeApp, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId };
}

async function stopLeaf(app) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  if (app.nodeApp && typeof app.nodeApp.stop === "function") await app.nodeApp.stop().catch(() => {});
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(400);
  }
  throw new Error("Timed out waiting for " + label + (lastError && lastError.message ? ": " + lastError.message : ""));
}

async function waitForPeerLinkReady(chat, peerAccountId, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("peer-links", "list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((item) => {
      if (!item || typeof item !== "object") return false;
      const remote = typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const state = typeof item.state === "string" ? item.state.trim() : "";
      const peerInboxId = typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      return remote === peerAccountId
        && (state === "established" || state === "session_established")
        && Boolean(peerInboxId);
    });
  }, CHAT_TIMEOUT_MS, label);
}

async function listMembers(chat, groupId) {
  const result = await chat.bus.call("group.members", "list", { groupId });
  return result && Array.isArray(result.items) ? result.items : [];
}

async function waitForGroupMember(chat, groupId, accountId, label) {
  return waitFor(async () => {
    const items = await listMembers(chat, groupId);
    return items.find((m) => m && String(m.accountId || "").trim() === accountId && m.state === "active");
  }, CHAT_TIMEOUT_MS, label);
}

async function listContacts(chat) {
  const result = await chat.bus.call("contacts", "list", {});
  return result && Array.isArray(result.items) ? result.items : [];
}

async function listThreads(chat) {
  const result = await chat.bus.call("threads", "list", { limit: 100 });
  return result && Array.isArray(result.threads) ? result.threads : [];
}

function contactFor(contacts, accountId, state) {
  return (contacts || []).find((c) => c
    && String(c.accountId || "").trim() === accountId
    && String(c.relationshipState || "").toLowerCase() === state) || null;
}

function directThreadFor(threads, accountId) {
  return (threads || []).find((t) => {
    if (!t || typeof t !== "object") return false;
    const type = String(t.threadType || "").trim().toLowerCase();
    const peer = typeof t.peerAccountId === "string" ? t.peerAccountId.trim() : "";
    return type === "direct" && peer === accountId;
  }) || null;
}

function memberName(members, accountId) {
  const row = (members || []).find((m) => m && String(m.accountId || "").trim() === accountId);
  return row && typeof row.displayName === "string" ? row.displayName.trim() : "";
}

test(
  "live local mesh: group co-membership does NOT create a 1:1 contact/thread (separation invariant)",
  { skip: !RUN, timeout: 120_000 },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-sep-"));
    const rPort = await getFreePort();
    const started = [];
    try {
      started.push(await startRezNode(relayOnlyConfig({
        dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1", knownRelays: [],
      })));

      const bob = await startChatLeaf({ tmp, label: "bob", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
      started.push(bob);
      const alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
      started.push(alice);
      const carol = await startChatLeaf({ tmp, label: "carol", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
      started.push(carol);

      await sleep(4_000);

      const nonce = String(Date.now());
      const groupTitle = "Bob Group " + nonce;

      // --- Bob founds the group ---
      const created = await bob.chat.bus.call("group", "create", { title: groupTitle, creatorDisplayName: "Bob" });
      const groupId = created.groupId;
      assert.ok(groupId, "Bob creates the group");

      // --- Bob ↔ Alice: a REAL direct contact (out-of-band direct invite) ---
      const directA = await bob.chat.bus.call("invite", "create", { kind: "direct", creatorDisplayName: "Bob" });
      await alice.chat.bus.call("invite", "accept", { inviteCode: directA.inviteCode, acceptorDisplayName: "Alice" });
      await waitForPeerLinkReady(bob.chat, alice.accountId, "Bob↔Alice DM ready");
      await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice↔Bob DM ready");

      // --- Bob ↔ Carol: a REAL direct contact ---
      const directC = await bob.chat.bus.call("invite", "create", { kind: "direct", creatorDisplayName: "Bob" });
      await carol.chat.bus.call("invite", "accept", { inviteCode: directC.inviteCode, acceptorDisplayName: "Carol" });
      await waitForPeerLinkReady(bob.chat, carol.accountId, "Bob↔Carol DM ready");
      await waitForPeerLinkReady(carol.chat, bob.accountId, "Carol↔Bob DM ready");

      // --- Bob group-invites Alice; Alice joins ---
      const groupInviteA = await bob.chat.bus.call("invite", "create", {
        kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Bob",
      });
      const joinA = await alice.chat.bus.call("invite", "accept", {
        inviteCode: groupInviteA.inviteCode, acceptorDisplayName: "Alice",
      });
      assert.equal(joinA.groupId, groupId, "Alice joins the group");
      await waitForGroupMember(bob.chat, groupId, alice.accountId, "Alice in Bob roster");

      // --- Bob group-invites Carol; Carol joins ---
      const groupInviteC = await bob.chat.bus.call("invite", "create", {
        kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Bob",
      });
      const joinC = await carol.chat.bus.call("invite", "accept", {
        inviteCode: groupInviteC.inviteCode, acceptorDisplayName: "Carol",
      });
      assert.equal(joinC.groupId, groupId, "Carol joins the group");
      await waitForGroupMember(bob.chat, groupId, carol.accountId, "Carol in Bob roster");

      // --- Alice and Carol learn each other (member.contact) and mesh DIRECTLY
      //     via the co-member bootstrap. This transport link MUST stay invisible. ---
      await waitForGroupMember(alice.chat, groupId, carol.accountId, "Carol in Alice roster");
      await waitForGroupMember(carol.chat, groupId, alice.accountId, "Alice in Carol roster");
      await waitForPeerLinkReady(alice.chat, carol.accountId, "Alice↔Carol transport link established");
      await waitForPeerLinkReady(carol.chat, alice.accountId, "Carol↔Alice transport link established");

      // Let any (erroneous) materialization flush before asserting absence.
      await sleep(3_000);

      // === POSITIVE CONTROL: Bob's real DMs exist on Alice and Carol ===
      const aliceContacts = await listContacts(alice.chat);
      const carolContacts = await listContacts(carol.chat);
      const aliceThreads = await listThreads(alice.chat);
      const carolThreads = await listThreads(carol.chat);

      assert.ok(contactFor(aliceContacts, bob.accountId, "active"), "Alice HAS an ACTIVE contact for Bob (real direct invite)");
      assert.ok(directThreadFor(aliceThreads, bob.accountId), "Alice HAS a DM thread for Bob");
      assert.ok(contactFor(carolContacts, bob.accountId, "active"), "Carol HAS an ACTIVE contact for Bob");
      assert.ok(directThreadFor(carolThreads, bob.accountId), "Carol HAS a DM thread for Bob");

      // === INVARIANT: co-membership did NOT create an ACTIVE Alice↔Carol
      //     contact or a DM thread. (A name-only `known` row IS expected — that's
      //     the SSOT name carrier, asserted below — but it is not a relationship.)
      const aliceCarolActive = contactFor(aliceContacts, carol.accountId, "active");
      const aliceCarolThread = directThreadFor(aliceThreads, carol.accountId);
      const carolAliceActive = contactFor(carolContacts, alice.accountId, "active");
      const carolAliceThread = directThreadFor(carolThreads, alice.accountId);

      assert.equal(aliceCarolActive, null,
        "SEPARATION: Alice must NOT have an ACTIVE 1:1 contact for co-member Carol");
      assert.equal(aliceCarolThread, null,
        "SEPARATION: Alice must NOT have a DM thread for co-member Carol (got "
        + JSON.stringify(aliceCarolThread && aliceCarolThread.threadId) + ")");
      assert.equal(carolAliceActive, null,
        "SEPARATION: Carol must NOT have an ACTIVE 1:1 contact for co-member Alice");
      assert.equal(carolAliceThread, null,
        "SEPARATION: Carol must NOT have a DM thread for co-member Alice (got "
        + JSON.stringify(carolAliceThread && carolAliceThread.threadId) + ")");

      // === SSOT NAME: the co-member's verified name lands in the ONE account
      //     table as a `known` row, propagated over real mesh — this is what the
      //     roster/DM UI resolves by accountId (member.displayName is no longer a
      //     display source). And the membership roster name resolves too.
      const aliceKnownCarol = contactFor(aliceContacts, carol.accountId, "known");
      const carolKnownAlice = contactFor(carolContacts, alice.accountId, "known");
      assert.ok(aliceKnownCarol, "Alice holds a `known` account row for co-member Carol");
      assert.equal(aliceKnownCarol.displayName, "Carol", "...carrying Carol's verified name");
      assert.ok(carolKnownAlice, "Carol holds a `known` account row for co-member Alice");
      assert.equal(carolKnownAlice.displayName, "Alice", "...carrying Alice's verified name");

      const aliceMembers = await listMembers(alice.chat, groupId);
      const carolMembers = await listMembers(carol.chat, groupId);
      assert.equal(memberName(aliceMembers, carol.accountId), "Carol",
        "Alice's roster carries Carol's NAME");
      assert.equal(memberName(carolMembers, alice.accountId), "Alice",
        "Carol's roster carries Alice's NAME");
    } finally {
      for (const app of started.reverse()) {
        if (app && app.chat) await stopLeaf(app);
        else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
      }
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
);
