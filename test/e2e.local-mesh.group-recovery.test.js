import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh GROUP RECOVERY e2e — fully un-mocked, loopback only.
 *
 * Reproduces the multi-peer-link failure that the single-link DM recovery e2e
 * could NOT catch (and that shipped broken in v0.5.0): a node in a real group
 * holds MORE THAN ONE peer-link, so when a group message can't be decrypted the
 * opaque packet can't be attributed to a specific link — the recipient-side
 * "exactly one candidate" trigger goes ambiguous and the link never heals.
 *
 * Topology: a 3-member meshed group (Alice creator, Bob, Carol). Each node holds
 * TWO peer-links. We then FORCE a genuine desync of ALICE's stored session for
 * BOB (Alice can no longer decrypt Bob; her link to Carol stays healthy — the
 * multi-link ambiguity). Bob keeps posting to the group:
 *   - Carol decrypts + acks Bob (healthy).
 *   - Alice cannot decrypt + never acks Bob.
 * So from BOB's send side, his messages to Alice go unacked while Carol's acks
 * flow — exact attribution. After the unacked threshold + timeout Bob re-invites
 * ALICE (sender-side recovery), the link re-establishes, and a POST-recovery Bob
 * group message decrypts on Alice. Proves the heal happens WITHOUT the recipient
 * needing to attribute the opaque packet.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 (real nodes + shared relay over loopback TCP).
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const CHAT_TIMEOUT_MS = 45_000;
// Sender-side recovery needs >= 3 unacked sends AND >= 45s of ack silence
// (SENDER_RECOVERY_UNACKED_THRESHOLD / _TIMEOUT_MS). Allow generous headroom for
// the re-invite -> accept -> handshake -> re-key round trip over the relay.
const HEAL_TIMEOUT_MS = 120_000;

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

async function pollMessageText(chat, threadId, text) {
  const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 80 });
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.find((m) => m && (m.text === text || (m.payload && m.payload.text === text))) || null;
}

async function waitForMessageText(chat, threadId, text, label) {
  return waitFor(() => pollMessageText(chat, threadId, text), CHAT_TIMEOUT_MS, label);
}

// Force a genuine desync of `node`'s stored session for `peerAccountId`: wipe the
// ratchet contexts but keep the session record active — a real "usable session
// that can't decrypt" (identical to the DM recovery harness). `node` keeps its
// OTHER peer-links intact, which is the multi-link ambiguity under test.
async function corruptStoredSession(node, peerAccountId) {
  const peerLinks = node.chat.bus.runtime && node.chat.bus.runtime.peerLinks;
  assert.ok(peerLinks, "chat runtime exposes peerLinks");
  const list = await peerLinks.listPeerLinks({ ownerAccountId: node.accountId });
  const link = (list.items || []).find((it) => it && it.peerAccountId === peerAccountId);
  assert.ok(link, "node holds a peer-link to the peer to corrupt");
  const sessions = peerLinks.peerLinkStorage.sessions;
  const sess = await sessions.getByPeerLinkId(node.accountId, link.peerLinkId);
  assert.ok(sess && sess.ratchetSnapshot, "peer-link has a stored session to corrupt");
  const snapshot = JSON.parse(JSON.stringify(sess.ratchetSnapshot));
  snapshot.sessions = {};
  await sessions.put({ ...sess, ratchetSnapshot: snapshot, status: "active" });
}

test("live local mesh: a desynced GROUP link self-heals via sender-side recovery (multi-link node)", {
  skip: !RUN ? "set RUN_LOCAL_MESH_E2E=1 to run live local-mesh group recovery e2e" : false,
  timeout: 240_000,
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-grouprec-"));
  const rPort = await getFreePort();
  const started = [];
  try {
    started.push(await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1", knownRelays: [],
    })));

    const alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(alice);
    const bob = await startChatLeaf({ tmp, label: "bob", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(bob);
    const carol = await startChatLeaf({ tmp, label: "carol", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(carol);

    await sleep(4_000);

    const nonce = String(Date.now());
    const groupTitle = "Recover3 " + nonce;

    // --- Build a fully-meshed 3-member group (Alice creates, invites Bob; Bob invites Carol) ---
    const created = await alice.chat.bus.call("group", "create", { title: groupTitle });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;

    const inviteB = await alice.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Alice",
    });
    const acceptedB = await bob.chat.bus.call("invite", "accept", { inviteCode: inviteB.inviteCode, acceptorDisplayName: "Bob" });
    const bobGroupThreadId = acceptedB.groupThreadId;
    assert.ok(bobGroupThreadId, "Bob has a group thread after accept");
    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice↔Bob ready");
    await waitForPeerLinkReady(bob.chat, alice.accountId, "Bob↔Alice ready");
    await waitForGroupMember(alice.chat, groupId, bob.accountId, "Bob in Alice roster");

    const inviteC = await bob.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Bob",
    });
    const acceptedC = await carol.chat.bus.call("invite", "accept", { inviteCode: inviteC.inviteCode, acceptorDisplayName: "Carol" });
    const carolThreadId = acceptedC.groupThreadId;

    // Full mesh: every node ends with TWO peer-links (the multi-link precondition).
    await waitForPeerLinkReady(alice.chat, carol.accountId, "Alice↔Carol meshed");
    await waitForPeerLinkReady(carol.chat, alice.accountId, "Carol↔Alice meshed");
    await waitForPeerLinkReady(bob.chat, carol.accountId, "Bob↔Carol ready");
    await waitForGroupMember(alice.chat, groupId, carol.accountId, "Carol in Alice roster");
    assert.equal((await listMembers(alice.chat, groupId)).length, 3, "Alice roster has 3");

    // Baseline: Bob's group message reaches Alice before we break the link.
    const baseline = "bob-baseline " + nonce;
    await bob.chat.bus.call("message", "send", {
      threadId: bobGroupThreadId,
      messageId: "bob_base_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: baseline },
    });
    await waitForMessageText(alice.chat, aliceThreadId, baseline, "Alice receives Bob baseline");

    // --- FORCE the desync: Alice can no longer decrypt Bob (her Carol link is fine) ---
    await corruptStoredSession(alice, bob.accountId);

    // Bob keeps posting. Carol acks (healthy); Alice can't decrypt + never acks.
    // Bob's unacked tally for Alice crosses the threshold/timeout and Bob
    // re-invites ALICE; the link re-keys and a POST-recovery Bob message decrypts
    // on Alice — even though Alice (2 links) could never attribute the miss herself.
    const deadline = Date.now() + HEAL_TIMEOUT_MS;
    let healed = false;
    let i = 0;
    while (Date.now() < deadline) {
      i += 1;
      const text = "bob-post-" + i + "-" + nonce;
      await bob.chat.bus.call("message", "send", {
        threadId: bobGroupThreadId,
        messageId: "bob_post_" + i + "_" + nonce,
        payload: { kind: "rez.chat.message.v1", text },
      });
      const got = await waitFor(() => pollMessageText(alice.chat, aliceThreadId, text), 5_000, "poll")
        .catch(() => null);
      if (got) { healed = true; break; }
    }
    assert.ok(healed, "Alice received a post-recovery Bob group message after the link re-established");

    // Carol was never disturbed — her link to Bob still delivers.
    const carolCheck = "bob-to-carol-still-ok " + nonce;
    await bob.chat.bus.call("message", "send", {
      threadId: bobGroupThreadId, messageId: "bob_carol_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: carolCheck },
    });
    await waitForMessageText(carol.chat, carolThreadId, carolCheck, "Carol still receives Bob (link untouched)");
  } finally {
    for (const app of started.reverse()) {
      if (app && app.chat) await stopLeaf(app);
      else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
