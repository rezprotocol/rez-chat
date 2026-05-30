import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { prepareElectronNativeModules, restoreNodeNativeModules } from "../scripts/desktop-native-modules.mjs";
import { resolveDesktopProfile } from "../scripts/desktop-dev-profile.mjs";

test("desktop dev profiles isolate Alice and Bob by default", () => {
  const alice = resolveDesktopProfile("alice", {});
  const bob = resolveDesktopProfile("bob", {});

  assert.equal(alice.name, "alice");
  assert.equal(alice.desktopPort, 3410);
  assert.equal(alice.nodeWsPort, 8787);
  assert.equal(alice.windowX, 24);
  assert.equal(alice.windowY, 48);
  assert.equal(alice.windowWidth, 680);
  assert.equal(alice.windowHeight, 820);
  assert.equal(alice.userDataDir.endsWith(path.join("rez-chat", ".local", "desktop-profiles", "alice")), true);

  assert.equal(bob.name, "bob");
  assert.equal(bob.desktopPort, 3420);
  assert.equal(bob.nodeWsPort, 8788);
  assert.equal(bob.windowX, 736);
  assert.equal(bob.windowY, 48);
  assert.equal(bob.windowWidth, 680);
  assert.equal(bob.windowHeight, 820);
  assert.equal(bob.userDataDir.endsWith(path.join("rez-chat", ".local", "desktop-profiles", "bob")), true);
  assert.notEqual(alice.userDataDir, bob.userDataDir);
});

test("desktop dev profile env overrides are profile-specific", () => {
  const alice = resolveDesktopProfile("alice", {
    REZ_CHAT_DESKTOP_PROFILE_ROOT: "/tmp/rez-desktop-profiles",
    REZ_CHAT_ALICE_DESKTOP_PORT: "3510",
    REZ_CHAT_ALICE_NODE_WS_PORT: "8887",
    REZ_CHAT_ALICE_WINDOW_X: "101",
    REZ_CHAT_ALICE_WINDOW_Y: "102",
    REZ_CHAT_ALICE_WINDOW_WIDTH: "720",
    REZ_CHAT_ALICE_WINDOW_HEIGHT: "740",
  });
  const bob = resolveDesktopProfile("bob", {
    REZ_CHAT_DESKTOP_PROFILE_ROOT: "/tmp/rez-desktop-profiles",
  });

  assert.equal(alice.userDataDir, path.join("/tmp/rez-desktop-profiles", "alice"));
  assert.equal(alice.desktopPort, 3510);
  assert.equal(alice.nodeWsPort, 8887);
  assert.equal(alice.windowX, 101);
  assert.equal(alice.windowY, 102);
  assert.equal(alice.windowWidth, 720);
  assert.equal(alice.windowHeight, 740);
  assert.equal(bob.userDataDir, path.join("/tmp/rez-desktop-profiles", "bob"));
  assert.equal(bob.desktopPort, 3420);
  assert.equal(bob.nodeWsPort, 8788);
});

test("desktop dev profile rejects unknown labels", () => {
  assert.throws(() => resolveDesktopProfile("charlie", {}), /Unknown desktop profile/);
});

test("desktop native module helper supports explicit skip flags", async () => {
  await prepareElectronNativeModules({
    REZ_CHAT_SKIP_ELECTRON_REBUILD: "1",
  });
  await restoreNodeNativeModules({
    REZ_CHAT_RESTORE_NODE_NATIVE: "0",
  });
});
