import test from "node:test";
import assert from "node:assert/strict";

import { redactText, redactValue, redactStack } from "../src/server/diagnostics/redact.js";

/**
 * rez-chat#7. A diagnostic bundle never leaves the machine on its own, but a
 * tester attaches it to a PUBLIC issue — so every test here asserts against the
 * standard "assume this ends up on the internet".
 *
 * The failure mode worth guarding is not "redaction is absent", it is
 * "redaction looked like it worked". So these check the NEGATIVE: that the
 * secret substring is nowhere in the output, rather than that the output
 * matches some expected shape.
 */

const ACCOUNT = "rez:acct:uasw5pxai7xpnppznl35ni6336acvrgttydunrc3owrggdp4ggiq";
const INBOX = "inbox:f85a1e1734a6b1c6511da77b";

test("account ids keep a correlatable prefix and lose the rest", () => {
  const out = redactText("peer " + ACCOUNT + " failed");
  assert.ok(out.includes("rez:acct:uasw"), "a short prefix survives so two events can be lined up");
  assert.ok(!out.includes("5pxai7xpnppznl35ni6336acvrgttydunrc3owrggdp4ggiq"), "the body must be gone");
  assert.ok(out.includes("<redacted>"));
});

test("the same account redacts identically (correlation still works)", () => {
  assert.equal(redactText("a " + ACCOUNT), "a " + redactText(ACCOUNT));
});

test("different accounts stay distinguishable", () => {
  const a = redactText("rez:acct:aaaa5pxai7xpnppznl35ni6336acvrgttydunrc3owrggdp4ggiq");
  const b = redactText("rez:acct:bbbb5pxai7xpnppznl35ni6336acvrgttydunrc3owrggdp4ggiq");
  assert.notEqual(a, b);
});

test("inbox/thread/group/message handles are truncated", () => {
  const out = redactText("deposit to " + INBOX + " in thread:9f2c1d4e5a6b7c8d");
  assert.ok(!out.includes("1e1734a6b1c6511da77b"));
  assert.ok(!out.includes("1d4e5a6b7c8d"));
});

test("invite and link codes are removed ENTIRELY, not truncated", () => {
  // These carry live key material; a prefix is not a safe thing to publish.
  const invite = "rez:invite:v3:AbCdEf0123456789+/xyzQRS";
  const link = "rez:link:v1:9f2c1d4e5a6b7c8d9e0f";
  const out = redactText("code " + invite + " and " + link);
  assert.ok(!out.includes("AbCdEf0123456789"));
  assert.ok(!out.includes("9f2c1d4e5a6b7c8d"));
  assert.ok(out.includes("rez:invite:<redacted>"));
  assert.ok(out.includes("rez:link:<redacted>"));
});

test("bulk base64 and long hex are removed", () => {
  const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w";
  const hex = "a3f5c7e91b2d4068a3f5c7e91b2d4068a3f5c7e91b2d4068";
  const out = redactText("key=" + b64 + " id=" + hex);
  assert.ok(!out.includes(b64));
  assert.ok(!out.includes(hex));
});

test("home directory paths lose the username", () => {
  assert.ok(!redactText("/Users/noah/code/thing.js").includes("noah"));
  assert.ok(!redactText("/home/alice/.local/share").includes("alice"));
  assert.ok(!redactText("C:\\Users\\Bob\\AppData").includes("Bob"));
});

test("content-bearing keys are DROPPED, not emptied", () => {
  const out = redactValue({
    text: "the actual message",
    displayName: "Carol",
    inviteCode: "rez:invite:v3:secret",
    threadId: "thread:9f2c1d4e5a6b7c8d",
    count: 3,
  });
  assert.ok(!("text" in out), "an emptied key still confirms a value existed");
  assert.ok(!("displayName" in out));
  assert.ok(!("inviteCode" in out));
  assert.equal(out.count, 3, "non-sensitive fields survive — the bundle must stay useful");
  assert.ok(String(out.threadId).includes("<redacted>"));
});

test("denied keys are matched case-insensitively", () => {
  const out = redactValue({ Text: "x", PRIVATEKEYB64: "y", Mnemonic: "z" });
  assert.deepEqual(Object.keys(out), []);
});

test("nested content is redacted at depth", () => {
  const out = redactValue({ a: { b: { c: { peer: ACCOUNT, text: "hi" } } } });
  assert.ok(!JSON.stringify(out).includes("5pxai7xpnppznl35"));
  assert.ok(!JSON.stringify(out).includes("hi"));
});

test("binary payloads report only their size", () => {
  const out = redactValue({ blob: new Uint8Array([1, 2, 3, 4]) });
  assert.equal(out.blob, "<binary:4b>");
});

test("cycles terminate instead of hanging", () => {
  const a = { name: "a" };
  a.self = a;
  assert.doesNotThrow(() => JSON.stringify(redactValue(a)));
  assert.equal(redactValue(a).self, "<cycle>");
});

test("depth is bounded", () => {
  let deep = { v: 1 };
  for (let i = 0; i < 30; i++) deep = { child: deep };
  const out = redactValue(deep, { maxDepth: 3 });
  assert.ok(JSON.stringify(out).includes("<max-depth>"));
});

test("Error objects keep name/message/code and a scrubbed stack", () => {
  const err = new Error("failed for " + ACCOUNT);
  err.code = "SOME_CODE";
  const out = redactValue({ err });
  assert.equal(out.err.name, "Error");
  assert.equal(out.err.code, "SOME_CODE");
  assert.ok(!out.err.message.includes("5pxai7xpnppznl35"));
  assert.ok(out.err.stack === null || !out.err.stack.includes("/Users/"));
});

test("stacks keep the frame but drop the absolute path", () => {
  const stack = [
    "Error: boom",
    "    at doThing (file:///Users/noah/code/personal/rezprotocol/rez-chat/src/x.js:12:9)",
    "    at async Y (/home/alice/y.js:3:1)",
  ].join("\n");
  const out = redactStack(stack);
  assert.ok(out.includes("doThing"), "the function name is the useful part");
  assert.ok(out.includes("x.js:12:9"), "basename + position survive");
  assert.ok(!out.includes("noah"));
  assert.ok(!out.includes("alice"));
});

test("redactStack tolerates a missing stack", () => {
  assert.equal(redactStack(undefined), null);
  assert.equal(redactStack(""), null);
});

test("stacks are truncated so a bundle cannot balloon", () => {
  const huge = ["Error: x"].concat(Array.from({ length: 500 }, (_, i) => "    at f" + i + " (a.js:1:1)")).join("\n");
  assert.ok(redactStack(huge).split("\n").length <= 40);
});

test("plain values pass through untouched", () => {
  assert.equal(redactText(""), "");
  assert.equal(redactValue(42), 42);
  assert.equal(redactValue(true), true);
  assert.equal(redactValue(null), null);
});
