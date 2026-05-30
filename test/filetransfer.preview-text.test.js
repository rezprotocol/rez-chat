import test from "node:test";
import assert from "node:assert/strict";
import { ServerThreadsService } from "../src/server/services/ServerThreadsService.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}

class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

function createBus() {
  const handlers = new Map();
  return {
    stores: {},
    services: {},
    registerFunction: ({ namespace, name, fn }) => { handlers.set(namespace + "." + name, fn); },
    call: (namespace, name, payload) => {
      const fn = handlers.get(namespace + "." + name);
      if (fn) return fn(payload);
      throw new Error("No handler for " + namespace + "." + name);
    },
    on: () => () => {},
    emit: () => {},
  };
}

test("extractPreviewText returns 'Photo' for image without caption", () => {
  const bus = createBus();
  const svc = new ServerThreadsService({
    bus,
    threadStore: { getThread: async () => null },
    threadIndex: { upsertFromMessage: async () => null },
    contactStore: {},
    groupStore: {},
    ownerAccountId: "rez:acct:test",
  });
  assert.equal(svc.extractPreviewText({ kind: "rez.image.v1", fileHashHex: "abc" }), "Photo");
  assert.equal(svc.extractPreviewText({ payload: { kind: "rez.image.v1" } }), "Photo");
});

test("extractPreviewText returns caption for image with text", () => {
  const bus = createBus();
  const svc = new ServerThreadsService({
    bus,
    threadStore: { getThread: async () => null },
    threadIndex: { upsertFromMessage: async () => null },
    contactStore: {},
    groupStore: {},
    ownerAccountId: "rez:acct:test",
  });
  assert.equal(svc.extractPreviewText({ kind: "rez.image.v1", text: "Check this out" }), "Check this out");
  assert.equal(svc.extractPreviewText({ payload: { kind: "rez.image.v1", text: "Look" } }), "Look");
});

test("extractPreviewText still returns text for normal messages", () => {
  const bus = createBus();
  const svc = new ServerThreadsService({
    bus,
    threadStore: { getThread: async () => null },
    threadIndex: { upsertFromMessage: async () => null },
    contactStore: {},
    groupStore: {},
    ownerAccountId: "rez:acct:test",
  });
  assert.equal(svc.extractPreviewText({ text: "Hello world" }), "Hello world");
  assert.equal(svc.extractPreviewText({ payload: { text: "Nested" } }), "Nested");
  assert.equal(svc.extractPreviewText({}), "");
});
