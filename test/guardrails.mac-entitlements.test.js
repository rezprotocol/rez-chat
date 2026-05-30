import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTITLEMENTS_PATH = path.resolve(__dirname, "..", "build", "entitlements.mac.plist");

/**
 * Guardrail: macOS Hardened Runtime entitlements must NOT include the
 * three keys that fully neutralize Hardened Runtime against local
 * dylib-injection attacks (SECURITY_AUDIT HIGH-11).
 *
 * Hardened Runtime is enabled in electron-builder.yml (`hardenedRuntime: true`),
 * but a single entitlement toggle can silently void the protection. This
 * test fails CI if any of the dangerous toggles reappears.
 *
 * Allowed:
 *   - com.apple.security.cs.allow-jit (V8 requires it)
 *
 * Forbidden without explicit security review:
 *   - com.apple.security.cs.allow-unsigned-executable-memory
 *   - com.apple.security.cs.allow-dyld-environment-variables
 *   - com.apple.security.cs.disable-library-validation
 */
test("guardrail: Hardened Runtime entitlements stay tight", () => {
  const plist = fs.readFileSync(ENTITLEMENTS_PATH, "utf8");
  const forbidden = [
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.cs.disable-library-validation",
  ];
  for (const key of forbidden) {
    assert.equal(
      plist.includes(key),
      false,
      `entitlements.mac.plist must not declare ${key} (SECURITY_AUDIT HIGH-11). `
        + "If a future Electron version legitimately requires it, add a comment "
        + "documenting the reason and update this test with an explicit allow.",
    );
  }
});
