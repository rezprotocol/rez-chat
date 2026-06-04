// Regression: the chat WS uplink lives inside ChatShellHost, which stays up
// across logout/login. Re-attaching a chat-server on re-login MUST NOT throw
// "BridgeRouter: namespace 'chat' already registered". That throw (observed
// 2026-06-04) failed startChatServer, so the post-relogin runtime never
// connected — inbox catch-up never ran, group rosters stayed stale, and group
// message delivery was dead. attachChatServer now starts from a clean router.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ChatWebsocketUplink } from "../src/server/transport/ChatWebsocketUplink.js";
import { CHAT_BRIDGE_SPEC } from "../src/server/transport/ChatBridge.js";

function makeChatServerStub() {
  const emitter = new EventEmitter();
  emitter.bridge = { getSpec: () => CHAT_BRIDGE_SPEC };
  return emitter;
}

test("uplink re-attach after detach (logout→login) does not throw 'namespace already registered'", () => {
  const uplink = new ChatWebsocketUplink({ server: new EventEmitter() });

  // First login.
  uplink.attachChatServer(makeChatServerStub());
  assert.equal(uplink.ready, true, "bridge ready after first attach");
  assert.deepEqual(uplink.router.listNamespaces(), ["chat"], "chat namespace registered");

  // Logout.
  uplink.detachChatServer();
  assert.equal(uplink.ready, false, "bridge not ready after detach");

  // Re-login: this is the case that used to throw before the fix.
  assert.doesNotThrow(() => {
    uplink.attachChatServer(makeChatServerStub());
  }, "re-attach after detach must not throw");
  assert.equal(uplink.ready, true, "bridge ready again after re-attach");
  assert.deepEqual(uplink.router.listNamespaces(), ["chat"], "chat namespace registered exactly once after re-attach");
});

test("uplink survives several logout/login cycles", () => {
  const uplink = new ChatWebsocketUplink({ server: new EventEmitter() });
  for (let i = 0; i < 4; i++) {
    uplink.attachChatServer(makeChatServerStub());
    assert.equal(uplink.ready, true, "ready on cycle " + i);
    assert.deepEqual(uplink.router.listNamespaces(), ["chat"], "single chat namespace on cycle " + i);
    uplink.detachChatServer();
  }
});
