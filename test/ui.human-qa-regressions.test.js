import test from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, FakeElement } from "./_helpers/fakeDom.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { SessionStore } from "../src/ui/stores/SessionStore.js";
import { ConnectionStore } from "../src/ui/stores/ConnectionStore.js";
import { OwnAvatarView } from "../src/ui/views/OwnAvatarView.js";
import { SettingsTabView } from "../src/ui/views/SettingsTabView.js";
import { MessageQueries } from "../src/ui/queries/MessageQueries.js";
import { ContactQueries } from "../src/ui/queries/ContactQueries.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const text = (node) => node.textContent || node.children.map(text).join(" ");
const images = (node) => [node, ...node.children.flatMap(images)].filter((child) => child.tagName === "IMG");

test("saved sibling accounts do not get self labels or own-message actions", () => {
  const session = new SessionStore({ bus: null });
  session.setAccountList([{ id: "a", accountIdHint: "account:alice" }, { id: "b", accountIdHint: "account:bob" }]);
  session.setUnlocked({ accountId: "b", ownerAccountId: "account:bob", deviceId: "b1" });
  const stores = {
    session, contacts: { getContact: () => null },
    messages: { getMessage: () => ({ speakerId: "account:alice", senderAccountId: "account:alice" }) },
  };
  assert.equal(new MessageQueries({ stores }).isOwnMessage("thread", "incoming"), false);
  assert.notEqual(new ContactQueries({ stores }).displayName("account:alice"), "You");
  assert.equal(new ContactQueries({ stores }).displayName("account:bob"), "You");
});

test("own avatar follows identity after mount and ignores superseded fetches", async () => {
  installFakeDom();
  const bus = new ChatServerBus();
  bus.stores.session = new SessionStore({ bus: null });
  const requests = [];
  bus.registerFunction({ namespace: "session", name: "getOwnAvatar", fn: (params) => new Promise((resolve) => requests.push({ params, resolve })) });
  const root = new FakeElement();
  const view = new OwnAvatarView({ bus, accountId: "", label: "Account" });
  view.mount(root);
  view.setAccount("avatar-test-alice", "Alice");
  assert.equal(requests[0].params.accountId, "avatar-test-alice");
  bus.emit("session.avatarChanged", { accountId: "avatar-test-alice" });
  assert.equal(requests.length, 2, "new save invalidates the original pending request");
  requests[1].resolve({ avatarDataB64: "TkVX" });
  await settle();
  requests[0].resolve({ avatarDataB64: "T0xE" });
  await settle();
  assert.equal(images(root)[0].attributes.get("src"), "data:image/jpeg;base64,TkVX");
  view.setAccount("avatar-test-bob", "Bob");
  assert.equal(images(root).length, 0, "different account never inherits Alice's image");
  view.unmount();
  view.mount(root);
  assert.equal(requests.length, 4, "remount starts a fresh request despite old pending work");
  requests[2].resolve({ avatarDataB64: "Qk9C" });
  await settle();
  assert.equal(images(root).length, 0, "old mount cannot repaint the new mount");
  requests[3].resolve({ avatarDataB64: "TkVXQk9C" });
  await settle();
  assert.equal(images(root)[0].attributes.get("src"), "data:image/jpeg;base64,TkVXQk9C");
  view.unmount();
  assert.equal(root.children.length, 0, "unmounted fetch cannot repaint");
});

test("web diagnostics show a version and distinguish count-only mesh status", () => {
  installFakeDom();
  const bus = new ChatServerBus();
  let mesh = { peerCount: 7, peers: [] };
  bus.stores.session = new SessionStore({ bus: null });
  bus.stores.connection = new ConnectionStore();
  bus.stores.connection.setConnection({ status: "connected", nodes: [{ url: "wss://chat.example/ws", active: true, ready: true, healthy: true }], mesh });
  const root = new FakeElement();
  const view = new SettingsTabView({ bus });
  view.mount(root);
  assert.match(text(root.querySelector('[data-testid="system.app-version"]')), /\d+\.\d+.*\(web\)/);
  assert.match(text(root.querySelector('[data-testid="system.mesh.peer.none"]')), /7 mesh peers.*details are unavailable/);
  assert.equal(text(root.querySelector('[data-testid="system.connected-node"]')), "Node: wss://chat.example/ws");
  mesh = { peerCount: 0, peers: [] };
  bus.stores.connection.setConnection({ mesh });
  assert.equal(text(root.querySelector('[data-testid="system.mesh.peer.none"]')), "No mesh peers reported");
  view.unmount();
});
