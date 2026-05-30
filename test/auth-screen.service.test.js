import test from "node:test";
import assert from "node:assert/strict";

import { ChatBus } from "../src/ui/root/ChatBus.js";
import { SessionStore, SESSION_STATUS } from "../src/ui/stores/SessionStore.js";
import { UiStateStore } from "../src/ui/stores/UiStateStore.js";
import { AuthScreenService } from "../src/ui/services/bus/AuthScreenService.js";

test("AuthScreenService forces create screen when no keystore is present", async () => {
  const bus = new ChatBus();
  const sessionStore = new SessionStore();
  const uiStateStore = new UiStateStore();
  const service = new AuthScreenService({ bus, sessionStore, uiStateStore });

  sessionStore.setNoKeystore();

  assert.equal(uiStateStore.snapshot().authScreen, "create");
  service.stop();
});

test("AuthScreenService preserves explicit create request while locked with accounts", async () => {
  const bus = new ChatBus();
  const sessionStore = new SessionStore();
  const uiStateStore = new UiStateStore();
  const service = new AuthScreenService({ bus, sessionStore, uiStateStore });

  sessionStore.setAccountList([{ id: "default", label: "Default" }]);
  sessionStore.setSelectedAccountId("default");
  sessionStore.setLocked();
  await bus.call("authScreen", "showCreate", {});

  assert.equal(uiStateStore.snapshot().authScreen, "create");
  service.stop();
});

test("AuthScreenService defaults back to unlock after bootstrap discovers existing accounts", async () => {
  const bus = new ChatBus();
  const sessionStore = new SessionStore();
  const uiStateStore = new UiStateStore();
  const service = new AuthScreenService({ bus, sessionStore, uiStateStore });

  sessionStore.setNoKeystore();
  assert.equal(uiStateStore.snapshot().authScreen, "create");

  sessionStore.setAccountList([{ id: "default", label: "Default" }]);
  sessionStore.setSelectedAccountId("default");
  sessionStore.setLocked();

  assert.equal(uiStateStore.snapshot().authScreen, "unlock");
  service.stop();
});

test("AuthScreenService resets auth screen to unlock after session unlocks", async () => {
  const bus = new ChatBus();
  const sessionStore = new SessionStore();
  const uiStateStore = new UiStateStore();
  const service = new AuthScreenService({ bus, sessionStore, uiStateStore });

  sessionStore.setAccountList([{ id: "default", label: "Default" }]);
  sessionStore.setSelectedAccountId("default");
  await bus.call("authScreen", "showCreate", {});
  sessionStore.setUnlocked({ accountId: "default", deviceId: "device-1" });

  assert.equal(sessionStore.snapshot().status, SESSION_STATUS.UNLOCKED);
  assert.equal(uiStateStore.snapshot().authScreen, "unlock");
  service.stop();
});
