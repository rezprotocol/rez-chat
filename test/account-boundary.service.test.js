import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/ui/stores/SessionStore.js";
import {
  ACCOUNT_SCOPED_STORE_NAMES,
  AccountBoundaryService,
} from "../src/ui/services/AccountBoundaryService.js";

function makeStores() {
  const resets = new Map();
  const stores = {};
  for (const name of ACCOUNT_SCOPED_STORE_NAMES) {
    resets.set(name, 0);
    stores[name] = {
      reset() {
        resets.set(name, resets.get(name) + 1);
      },
    };
  }
  return { stores, resets };
}

function assertResetCount(resets, expected) {
  for (const name of ACCOUNT_SCOPED_STORE_NAMES) {
    assert.equal(resets.get(name), expected, name);
  }
}

test("AccountBoundaryService resets every account-scoped store across account boundaries", () => {
  const sessionStore = new SessionStore();
  const { stores, resets } = makeStores();
  const service = new AccountBoundaryService({ sessionStore, stores });
  service.start();

  sessionStore.setAccountList([{ id: "slot-a" }]);
  assertResetCount(resets, 0);

  sessionStore.setUnlocked({ accountId: "slot-a", ownerAccountId: "acct-a" });
  assertResetCount(resets, 1);

  sessionStore.setUnlocked({ accountId: "slot-a", ownerAccountId: "acct-a" });
  assertResetCount(resets, 1);

  sessionStore.setLocked();
  assertResetCount(resets, 2);

  sessionStore.setUnlocked({ accountId: "slot-b", ownerAccountId: "acct-b" });
  assertResetCount(resets, 3);

  service.stop();
  sessionStore.setLocked();
  assertResetCount(resets, 3);
});

test("AccountBoundaryService refuses incomplete store wiring", () => {
  const sessionStore = new SessionStore();
  const { stores } = makeStores();
  delete stores.messages;
  assert.throws(
    () => new AccountBoundaryService({ sessionStore, stores }),
    /resettable store: messages/,
  );
});
