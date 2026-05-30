import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "src");
const TEST_DIR = path.resolve(import.meta.dirname);
const LEGACY_PATTERNS = [
  /['"]\.\.\/app\//,
  /['"]\.\/app\//,
  /['"]\.\.\/src\/app\//,
  /from\s+['"][^'"]*\/src\/app\//,
  /import\s+['"][^'"]*\/src\/app\//,
];

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

test("no source file imports from src/app/", () => {
  const files = walkDir(SRC_DIR);
  const violations = [];
  for (const file of files) {
    const relativePath = path.relative(SRC_DIR, file);
    if (relativePath.startsWith("server/")) {
      continue;
    }
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of LEGACY_PATTERNS) {
        if (pattern.test(lines[i])) {
          violations.push(`${relativePath}:${i + 1}  ${lines[i].trim()}`);
        }
      }
    }
  }
  assert.equal(violations.length, 0, `Legacy src/app imports found:\n${violations.join("\n")}`);
});

test("no test file imports from src/app/", () => {
  const files = walkDir(TEST_DIR);
  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of LEGACY_PATTERNS) {
        if (pattern.test(lines[i])) {
          violations.push(`${path.relative(TEST_DIR, file)}:${i + 1}  ${lines[i].trim()}`);
        }
      }
    }
  }
  assert.equal(violations.length, 0, `Legacy src/app imports found in tests:\n${violations.join("\n")}`);
});

test("src/app folder does not exist", () => {
  const appDir = path.join(SRC_DIR, "app");
  assert.equal(fs.existsSync(appDir), false, `Legacy app folder still exists: ${appDir}`);
});
