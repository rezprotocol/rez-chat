import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");

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

test("rez-chat must not import rez-core directly (must go through rez-sdk)", () => {
  const files = walk(SRC);
  const violations = [];

  for (const file of files) {
    const specifiers = extractSpecifiers(fs.readFileSync(file, "utf8"));
    for (const raw of specifiers) {
      const s = String(raw || "").trim().replace(/\\/g, "/");

      if (s === "@rezprotocol/core" || s.startsWith("@rezprotocol/core/")) {
        violations.push(`${path.relative(SRC, file)} -> ${s}`);
      }
      if (s.includes("../rez-core/") || s.includes("/rez-core/")) {
        violations.push(`${path.relative(SRC, file)} -> workspace path import ${s}`);
      }
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});
