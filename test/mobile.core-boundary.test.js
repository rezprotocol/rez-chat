// P1.1 (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md) — the mechanical
// core-boundary guardrail. `startRezChatCore` must stay runtime-neutral and
// shell-independent: its TRANSITIVE rez-chat import graph may not reach
// `node:` builtins, `@rezprotocol/node` (the local rez-node — a phone has
// none), the `ws` package (the host supplies wsFactory), the desktop tree,
// or the shell host/config modules. rez-sdk is already proven clean of
// `node:` imports (P1.1 trace), and rez-chat may not import rez-core at all
// (the existing boundary test) — so walking the rez-chat-local graph plus a
// direct sweep of rez-sdk sources covers the whole runtime surface.
//
// The frozen architectural guardrail is also pinned here: the mobile entry
// module exposes startRezChatCore and NOTHING else — providers in,
// runtime+adapter out, no mobile-specific domain methods ever.
//
// P1.3a extends the SAME walk to the second mobile entry point,
// `enrollDelegatedDevice` — same bans, plus: the enrollment module may not
// reach the desktop/browser runner trees (src/client/, src/ui/) — its
// wsFactory/crypto/keystore come from the host, never from a hosted-runtime
// runner.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ENTRY = path.resolve("src/mobile/startRezChatCore.js");
const ENROLL_ENTRY = path.resolve("src/mobile/enrollDelegatedDevice.js");
const ACTIVATE_ENTRY = path.resolve("src/mobile/activateDelegatedDevice.js");
const PREPARE_BOOT_ENTRY = path.resolve("src/mobile/prepareDelegatedCoreBoot.js");
const SRC = path.resolve("src");

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractSpecifiers(text) {
  const stripped = stripComments(text);
  const out = [];
  const importFromRe = /^\s*import\s+[^;]*?\s+from\s+["']([^"']+)["']/gm;
  const exportFromRe = /^\s*export\s+[^;]*?\s+from\s+["']([^"']+)["']/gm;
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importFromRe, exportFromRe, dynamicImportRe]) {
    let m;
    while ((m = re.exec(stripped)) != null) out.push(m[1]);
  }
  return out;
}

// Walk the rez-chat-local transitive graph from the entry point.
function walkGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  const externalSpecifiers = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const specifiers = extractSpecifiers(fs.readFileSync(file, "utf8"));
    for (const raw of specifiers) {
      const s = String(raw || "").trim();
      if (s.startsWith(".")) {
        let resolved = path.resolve(path.dirname(file), s);
        if (!resolved.endsWith(".js")) {
          resolved = fs.existsSync(resolved + ".js") ? resolved + ".js" : path.join(resolved, "index.js");
        }
        queue.push(resolved);
      } else {
        externalSpecifiers.push({ file: path.relative(SRC, file), specifier: s });
      }
    }
  }
  return { files: seen, externalSpecifiers };
}

function collectViolations(entry, { banHostedRunnerTrees = false } = {}) {
  const { files, externalSpecifiers } = walkGraph(entry);

  const violations = [];
  for (const { file, specifier } of externalSpecifiers) {
    if (specifier.startsWith("node:")) violations.push(file + " -> " + specifier);
    if (specifier === "@rezprotocol/node" || specifier.startsWith("@rezprotocol/node/")) violations.push(file + " -> " + specifier);
    if (specifier === "ws") violations.push(file + " -> " + specifier + " (the host supplies wsFactory)");
  }
  for (const file of files) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    if (rel.startsWith("desktop/")) violations.push("graph reaches desktop tree: " + rel);
    if (rel.startsWith("server/host/")) violations.push("graph reaches shell host: " + rel);
    if (rel.startsWith("server/config/")) violations.push("graph reaches desktop config: " + rel);
    if (rel === "server/bootstrap/bootstrapChatServer.js") violations.push("graph reaches the Node/desktop adapter: " + rel);
    if (rel === "index.js") violations.push("graph reaches the desktop composition root");
    if (banHostedRunnerTrees) {
      if (rel.startsWith("client/")) violations.push("graph reaches the browser runtime tree: " + rel);
      if (rel.startsWith("ui/")) violations.push("graph reaches the UI tree: " + rel);
    }
  }

  // Only @rezprotocol/sdk externals remain (rez-core is banned repo-wide by
  // the existing boundary test; anything else would be a new dependency).
  for (const { file, specifier } of externalSpecifiers) {
    if (!specifier.startsWith("@rezprotocol/sdk")) {
      violations.push("unexpected external import: " + file + " -> " + specifier);
    }
  }
  return violations;
}

test("P1.1 boundary: startRezChatCore's transitive graph reaches no node builtins, no local rez-node, no ws package, no desktop/shell modules", () => {
  const violations = collectViolations(ENTRY);
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("P1.3a boundary: enrollDelegatedDevice's transitive graph obeys the same bans and never reaches the desktop/browser runners", () => {
  const violations = collectViolations(ENROLL_ENTRY, { banHostedRunnerTrees: true });
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("P1.3b boundary: activateDelegatedDevice's transitive graph obeys the same bans and never reaches the desktop/browser runners", () => {
  const violations = collectViolations(ACTIVATE_ENTRY, { banHostedRunnerTrees: true });
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("P1.3c boundary: prepareDelegatedCoreBoot's transitive graph obeys the same bans and never reaches the desktop/browser runners", () => {
  const violations = collectViolations(PREPARE_BOOT_ENTRY, { banHostedRunnerTrees: true });
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("P1.1 boundary: rez-sdk sources (the graph's only external) contain no node: imports on the ws path", () => {
  const sdkSrc = path.resolve("../rez-sdk/src");
  // TcpTransport is DYNAMICALLY imported only for tcp://\/tls:// uplinks
  // ("server-side only" by its own contract) — a ws:// mobile boot never
  // loads it. It is the one sanctioned node-coupled module; everything else
  // must be clean, and nothing may import it STATICALLY.
  const LAZY_TCP = "transport/TcpTransport.js";
  const violations = [];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (full.endsWith(".js")) {
        const rel = path.relative(sdkSrc, full).replace(/\\/g, "/");
        const text = fs.readFileSync(full, "utf8");
        for (const s of extractSpecifiers(text)) {
          if ((s.startsWith("node:") || s === "ws") && rel !== LAZY_TCP) {
            violations.push(rel + " -> " + s);
          }
        }
        // No STATIC import of the sanctioned lazy module.
        if (rel !== LAZY_TCP && /^\s*(import|export)\s+[^;]*?from\s+["'][^"']*TcpTransport/m.test(stripComments(text))) {
          violations.push(rel + " -> static TcpTransport import (must stay lazy)");
        }
      }
    }
  };
  walkDir(sdkSrc);
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("P1.1 guardrail: the mobile entry module exports startRezChatCore and nothing else — no domain methods, ever", async () => {
  const mod = await import("../src/mobile/startRezChatCore.js");
  assert.deepEqual(Object.keys(mod).sort(), ["startRezChatCore"],
    "the entry point accepts providers/configuration; domain operations live behind the runtime directives and the adapter");
});

test("P1.3a guardrail: the enrollment module exports enrollDelegatedDevice and nothing else — one verb whose name is the ceremony", async () => {
  const mod = await import("../src/mobile/enrollDelegatedDevice.js");
  assert.deepEqual(Object.keys(mod).sort(), ["enrollDelegatedDevice"],
    "providers in, sealed-envelope identity facts out; no domain methods beyond the ceremony");
});

test("P1.3b guardrail: the activation module exports activateDelegatedDevice and nothing else — one verb whose name is the transaction", async () => {
  const mod = await import("../src/mobile/activateDelegatedDevice.js");
  assert.deepEqual(Object.keys(mod).sort(), ["activateDelegatedDevice"],
    "providers in, activation facts out; no domain methods beyond the bounded session");
});

test("P1.3c guardrail: the boot-mapping module exports prepareDelegatedCoreBoot and nothing else — mapping only, no domain verbs", async () => {
  const mod = await import("../src/mobile/prepareDelegatedCoreBoot.js");
  assert.deepEqual(Object.keys(mod).sort(), ["prepareDelegatedCoreBoot"],
    "unlocked envelope + providers in, startRezChatCore inputs out; it interprets enrollment truth, never establishes it");
});
