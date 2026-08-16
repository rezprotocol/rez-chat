import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DT-003 boundary guardrails (frozen delivery-transports plan, Phase 0).
// WHAT THIS ENFORCES:
//   1. No carrier adapters in rez-chat: chat is app logic; carriers are
//      RDeliveryTransport adapters in rez-sdk. Carrier protocol vocabulary
//      (smtp/imap/nodemailer/...) must not appear in chat source.
//   2. Chat never writes SDK- or node-owned KV prefixes (peer-link:*, sdk:*,
//      outbound:*) — prefix ownership is the only isolation on the shared
//      store, so a literal cross-prefix write is corruption of another
//      layer's state.
// WHAT IS DELIBERATELY NOT ENFORCED: the bare word "email" (legitimate UI
// prose), and prose mentions of "peer-link" WITHOUT the key-literal colon
// form — only quoted string literals beginning with an owned prefix count.
// See rez-core/docs/adr/ADR-DELIVERY-TRANSPORT-LAYERS.md and CLAUDE.md §3.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(CHAT_ROOT, "src");

const CARRIER_PATTERN = /smtp|imap|nodemailer|mailparser|\bpop3\b/i;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith(".js")) out.push(full);
  }
  return out;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no carrier adapters in rez-chat (smtp/imap/... vocabulary banned in src)", () => {
  const violations = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(CHAT_ROOT, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (CARRIER_PATTERN.test(lines[i])) {
        violations.push(rel + ":" + (i + 1) + "  " + lines[i].trim());
      }
    }
  }
  assert.deepEqual(violations, [],
    "Carrier protocol code appeared in rez-chat. Carriers are RDeliveryTransport "
    + "adapters in rez-sdk; chat consumes delivery through the SDK seam only. "
    + "See rez-core/docs/adr/ADR-DELIVERY-TRANSPORT-LAYERS.md.\n" + violations.join("\n"));
});

test("chat never writes SDK/node-owned KV prefixes (peer-link:*, sdk:*, outbound:*)", () => {
  const violations = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(CHAT_ROOT, file);
    const stripped = stripComments(fs.readFileSync(file, "utf8"));
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/["'`](peer-link:|sdk:|outbound:)/.test(lines[i])) {
        violations.push(rel + ":" + (i + 1) + "  " + lines[i].trim());
      }
    }
  }
  assert.deepEqual(violations, [],
    "Chat code referenced an SDK- or node-owned KV prefix literal. The shared "
    + "store is isolated by prefix ownership ONLY (chat: app:*/chat-server:*): "
    + "writing another layer's prefix corrupts its state.\n" + violations.join("\n"));
});
