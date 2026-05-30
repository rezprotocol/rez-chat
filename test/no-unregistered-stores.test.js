import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const STORES_DIR = path.resolve(import.meta.dirname, "..", "src", "ui", "stores");
const CHAT_APP = path.resolve(import.meta.dirname, "..", "src", "ui", "root", "ChatApp.js");

// Every *Store.js file under src/ui/stores/ must be wired into
// ChatApp._createStores (which is the single source of truth for the
// renderer store graph). This replaces the older barrel-scanning check
// — the barrel was deleted, but the actual policy still holds: a store
// is "registered" iff ChatApp constructs it.
test("every *Store.js in src/ui/stores/ is constructed in ChatApp._createStores", () => {
  const storeFiles = fs.readdirSync(STORES_DIR)
    .filter((f) => f.endsWith("Store.js") && f !== "StoreBase.js");

  assert.ok(storeFiles.length > 0, "Expected at least one store file");

  const chatAppSource = fs.readFileSync(CHAT_APP, "utf8");
  const missing = [];

  for (const file of storeFiles) {
    const className = file.replace(/\.js$/, "");
    const importPattern = `from "../stores/${file}"`;
    const constructPattern = `new ${className}(`;
    if (!chatAppSource.includes(importPattern) || !chatAppSource.includes(constructPattern)) {
      missing.push(file);
    }
  }

  assert.equal(
    missing.length,
    0,
    `Store files not wired into ChatApp._createStores:\n  ${missing.join("\n  ")}\nSee docs/NO_NEW_STORAGE.md for the policy.`
  );
});
