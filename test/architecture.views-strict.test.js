// Phase 5 guardrails: codify the post-migration invariants for src/ui/views/
// so the cross-store-derivation-in-views drift we just cleaned up cannot
// silently reappear.
//
// What this test enforces, and WHY each rule lives here:
//
//   1. No `.snapshot(` reads anywhere under src/ui/views/.
//      The store snapshot is a debug/serialization surface, not a render
//      input. Views read typed own-data accessors or call queries.
//
//   2. No store file under src/ui/stores/ imports another store file.
//      Cross-store derivation belongs in src/ui/queries/. A store that
//      reads a peer store is a layer violation and the foot-gun that
//      shipped two production bugs in this codebase.
//
//   3. No raw session-status string literals ("UNLOCKED", "LOCKED",
//      "UNLOCKING", "INITIALIZING", "LOCKING", "NO_KEYSTORE") in views.
//      Views must import SESSION_STATUS from SessionStore and compare
//      against the constant. String literals drift; constants don't.
//
//   4. No defensive `typeof <storeOrQueryRef> === "function"` checks in
//      views. ChatApp owns the wiring; views trust `bus.stores.X` and
//      `bus.queries.X` exist. Defensive checks are dead code that hide
//      the real bug (a store wasn't registered).
//
//   5. No imports of deleted cross-store presenter helpers in views.
//      `resolveSelfLabel`, `findSelfLabel`, `resolveAccountLabel`,
//      `resolveThreadLabel`, `resolveThreadDisplayLabel`,
//      `resolveMessageSenderLabel`, `isSelfIdentity`, `resolvePeerLabel`,
//      `resolveThreadMemberIds`, and `resolveThreadMemberLabels` were
//      removed in favor of queries + SessionStore.selfLabel().
//      `presenters/labels.js` is pure formatters only now.
//
// Two rules from the original Phase 5 plan are intentionally NOT
// enforced here:
//
//   - "Ban .filter/.find/.sort in *View.js". Legit local-array uses
//     (filter(Boolean), filter local UI state, etc.) make this noisy
//     without a smart predicate, and would force allow-list carve-outs
//     — the opposite of "strict, no allow-list". The intent (don't
//     iterate store data in views to derive answers) is covered by
//     rule #1 (no snapshot) plus the existence of queries.
//
//   - "Ban two distinct stores.* reads in one view file". Most parent
//     views legitimately read multiple stores (membership, list, ui
//     selection). The intent (don't combine cross-store data into a
//     view-local derivation) is covered by rules #1 and #2 plus the
//     queries layer.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "src");
const VIEWS_DIR = path.join(SRC_DIR, "ui", "views");
const STORES_DIR = path.join(SRC_DIR, "ui", "stores");

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

function relView(file) {
  return path.relative(SRC_DIR, file);
}

function scanLines(file, predicate) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i], i + 1, lines)) {
      hits.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

test("Phase 5: no .snapshot() reads anywhere in src/ui/views/", () => {
  const violations = [];
  for (const file of listJsFiles(VIEWS_DIR)) {
    const hits = scanLines(file, (line) => /\.snapshot\s*\(/.test(line));
    for (const hit of hits) {
      violations.push(`${relView(file)}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(violations, [],
    "Views must read typed own-data accessors or call queries, never .snapshot():\n"
    + violations.join("\n"));
});

test("Phase 5: no store file imports another store file", () => {
  const violations = [];
  const storeFiles = listJsFiles(STORES_DIR);
  const storeBasenames = new Set(storeFiles.map((f) => path.basename(f, ".js")));
  for (const file of storeFiles) {
    const base = path.basename(file, ".js");
    const hits = scanLines(file, (line) => {
      const match = line.match(/^\s*import\s+[^"']+["']\.\/([A-Za-z][A-Za-z0-9]*)(?:\.js)?["']/);
      if (!match) return false;
      const importedBase = match[1];
      if (importedBase === base) return false;
      if (importedBase === "StoreBase") return false;
      return storeBasenames.has(importedBase);
    });
    for (const hit of hits) {
      violations.push(`${relView(file)}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(violations, [],
    "Stores own their state and read no peers. Cross-store derivation lives in src/ui/queries/:\n"
    + violations.join("\n"));
});

test("Phase 5: no raw session-status string literals in views", () => {
  // Match the bare literal token preceded by `=== "` or `!== "`. This
  // catches `status === "UNLOCKED"` etc. without false-positiving on
  // unrelated strings that happen to contain the same word.
  const statusValues = ["UNLOCKED", "LOCKED", "UNLOCKING", "INITIALIZING", "LOCKING", "NO_KEYSTORE"];
  const pattern = new RegExp(`[!=]==\\s*["'](${statusValues.join("|")})["']`);
  const violations = [];
  for (const file of listJsFiles(VIEWS_DIR)) {
    const hits = scanLines(file, (line) => pattern.test(line));
    for (const hit of hits) {
      violations.push(`${relView(file)}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(violations, [],
    "Views must compare against SESSION_STATUS.<NAME>, not string literals:\n"
    + violations.join("\n"));
});

test("Phase 5: no defensive typeof === \"function\" checks for stores or queries in views", () => {
  // Pattern catches `typeof storeOrQueryRef.method === "function"` or
  // `typeof storeOrQueryRef === "function"` immediately following a
  // `stores.X`, `queries.X`, `bus.stores.X`, or `bus.queries.X` capture
  // on the same line.
  const guardPattern = /typeof\s+(?:[a-zA-Z_$][\w$]*\.)*(?:store|queries|stores)[\w$.]*\s*===?\s*["']function["']/i;
  const altPattern = /(?:bus\.)?(?:stores|queries)\s*&&\s*typeof\s+[a-zA-Z_$][\w$.]*\s*===?\s*["']function["']/;
  const violations = [];
  for (const file of listJsFiles(VIEWS_DIR)) {
    const hits = scanLines(file, (line) => guardPattern.test(line) || altPattern.test(line));
    for (const hit of hits) {
      violations.push(`${relView(file)}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(violations, [],
    "Views must trust bus.stores.* and bus.queries.* wiring. Drop defensive typeof checks:\n"
    + violations.join("\n"));
});

test("Phase 5: no imports of deleted cross-store presenter helpers in views", () => {
  const deleted = [
    "resolveSelfLabel",
    "findSelfLabel",
    "resolveAccountLabel",
    "resolveThreadLabel",
    "resolveThreadDisplayLabel",
    "resolveMessageSenderLabel",
    "isSelfIdentity",
    "resolvePeerLabel",
    "resolveThreadMemberIds",
    "resolveThreadMemberLabels",
  ];
  const violations = [];
  for (const file of listJsFiles(VIEWS_DIR)) {
    const text = fs.readFileSync(file, "utf8");
    // Only look in import statements — a view defining its own private
    // method with a colliding name (e.g. `#resolveSelfLabel()`) is fine;
    // what we want to forbid is reaching for the deleted exported helper.
    const importLines = text.split("\n").filter((line) => /^\s*import\s/.test(line));
    const importBlob = importLines.join("\n");
    for (const name of deleted) {
      const re = new RegExp(`\\b${name}\\b`);
      if (re.test(importBlob)) {
        violations.push(`${relView(file)}: imports deleted helper '${name}'`);
      }
    }
  }
  assert.deepEqual(violations, [],
    "These helpers were deleted in the queries migration; route through bus.queries / SessionStore.selfLabel() instead:\n"
    + violations.join("\n"));
});
