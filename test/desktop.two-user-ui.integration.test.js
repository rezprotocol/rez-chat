/**
 * End-to-end UI test for the desktop app.
 *
 * Launches TWO real Electron processes (the actual main.mjs that ships in
 * the .app bundle) with separate user-data-dirs and node WS ports, drives
 * each through the REAL renderer UI:
 *   signup → connect → generate invite (window A)
 *   read invite code from window A's UI → paste + accept (window B)
 *   wait for thread to appear on BOTH sides
 *   send message A → B via composer, assert it arrives on B
 *   send message B → A via composer, assert it arrives on A
 *
 * This is the only test that covers the FULL stack: renderer + preload +
 * ipcRenderer.invoke("bus:call") + ipcMain.handle("bus:call") +
 * DesktopBusBridge + ChatBridge + ChatServerBus + live mesh + reverse
 * `webContents.send("bus:event")` round-trip. The integration test in
 * desktop.two-user-events.integration.test.js exercises the bridge layer
 * in-process; THIS test additionally verifies the IPC hop and rendered UI.
 *
 * Gated on `RUN_INTEGRATION=1`. Takes ~30s. Requires the prebuilt UI
 * artifacts at rez-chat/artifacts/rez-chat/ (run `npm -w rez-chat run build`
 * first or `npm -w rez-chat run desktop:pack:dir` for full coverage).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");

const shouldRun = String(process.env.RUN_INTEGRATION || "").trim() === "1";

async function launchInstance(playwright, { label, userDataDir, nodeWsPort, desktopPort }) {
  const electronApp = await playwright._electron.launch({
    args: [path.join(CHAT_ROOT, "electron/main.mjs")],
    env: {
      ...process.env,
      REZ_CHAT_PROFILE: label,
      REZ_CHAT_USER_DATA_DIR: userDataDir,
      REZ_CHAT_DESKTOP_PORT: String(desktopPort),
      REZ_NODE_WS_PORT: String(nodeWsPort),
      CHAT_ID: "ui-test-" + label,
    },
    cwd: CHAT_ROOT,
    timeout: 30000,
  });
  const page = await electronApp.firstWindow({ timeout: 30000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  return { electronApp, page };
}

async function signup(page, profileName) {
  await page.waitForSelector("[data-role='create-account-form']", { timeout: 15000 });
  await page.fill("[data-role='signup-name']", profileName);
  await page.fill("[data-role='signup-password']", "ui-test-password");
  await page.fill("[data-role='signup-confirm']", "ui-test-password");
  // Force submission via the form-submit DOM event directly so we don't
  // depend on click/Enter routing.
  await page.evaluate(() => {
    const form = document.querySelector("[data-role='create-account-form']");
    if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.waitForSelector("[data-testid='nav.chat']", { timeout: 30000 });
}

async function gotoContactsTab(page) {
  await page.click("[data-testid='nav.contacts']");
  // InviteFormsView mounts as the default pane on Contacts.
  await page.waitForSelector("[data-testid='invite.create.direct.button']", { timeout: 10000 });
}

async function gotoChatsTab(page) {
  await page.click("[data-testid='nav.chat']");
  // Wait for chats tab to be active.
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-nav-id='chat']");
    return el && el.className && el.className.includes("border-primary");
  }, null, { timeout: 5000 });
}

async function generateInviteCode(page) {
  await page.click("[data-testid='invite.create.direct.button']");
  // Wait for the last-invite-code text to appear.
  await page.waitForSelector("[data-testid='invite.lastCreated.code']", { timeout: 30000 });
  const code = await page.textContent("[data-testid='invite.lastCreated.code']");
  return String(code || "").trim();
}

async function acceptInvite(page, inviteCode) {
  await page.fill("[data-testid='invite.accept.input']", inviteCode);
  await page.click("[data-testid='invite.accept.button']");
  // The view either navigates to chat or shows an error; wait for the
  // success indicator OR the chats tab to become active.
  await page.waitForFunction(() => {
    const successEl = document.querySelector("[data-testid='invite.accept.success']");
    if (successEl && !successEl.classList.contains("hidden")) return true;
    const navChat = document.querySelector("[data-nav-id='chat']");
    if (navChat && navChat.className && navChat.className.includes("border-primary")) return true;
    return false;
  }, null, { timeout: 45000 });
}

async function waitForThreadRow(page, label, timeoutMs = 45000) {
  await page.waitForSelector("[data-testid='thread.row']", { timeout: timeoutMs });
  const rows = await page.locator("[data-testid='thread.row']").count();
  if (rows === 0) throw new Error("[" + label + "] no thread rows rendered");
}

async function selectFirstThread(page) {
  await page.click("[data-testid='thread.row']");
  // Wait for composer to become enabled (not disabled).
  await page.waitForFunction(() => {
    const input = document.querySelector("[data-testid='composer.input']");
    return input && input.disabled !== true;
  }, null, { timeout: 60000 });
}

async function sendMessage(page, text) {
  await page.fill("[data-testid='composer.input']", text);
  await page.click("[data-testid='composer.send']");
}

async function waitForMessageText(page, text, label, timeoutMs = 30000) {
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll("[data-testid='message.text']");
    for (const n of nodes) {
      if (String(n.textContent || "").trim() === needle) return true;
    }
    return false;
  }, text, { timeout: timeoutMs });
}

test("two-user UI: signup, invite, accept, bidirectional messaging via real Electron renderer",
  { skip: shouldRun ? false : "set RUN_INTEGRATION=1 to enable (launches 2 electron windows, uses live relays, ~30s)" },
  async (t) => {
    // Confirm UI artifacts exist (electron main.mjs requires them).
    const uiRoot = path.resolve(CHAT_ROOT, "../artifacts/rez-chat");
    if (!fs.existsSync(path.join(uiRoot, "index.html"))) {
      t.skip("UI artifacts missing at " + uiRoot + " — run `npm -w rez-chat run build` first");
      return;
    }

    let playwright;
    try {
      playwright = await import("playwright");
    } catch {
      t.skip("playwright not installed");
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rez-ui-twouser-"));
    const aliceDir = path.join(root, "alice");
    const bobDir = path.join(root, "bob");
    fs.mkdirSync(aliceDir, { recursive: true });
    fs.mkdirSync(bobDir, { recursive: true });

    let alice = null;
    let bob = null;
    t.after(async () => {
      if (alice) await alice.electronApp.close().catch(() => {});
      if (bob) await bob.electronApp.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    });

    alice = await launchInstance(playwright, {
      label: "alice",
      userDataDir: aliceDir,
      nodeWsPort: 18831,
      desktopPort: 18931,
    });
    bob = await launchInstance(playwright, {
      label: "bob",
      userDataDir: bobDir,
      nodeWsPort: 18832,
      desktopPort: 18932,
    });

    // Surface all renderer console output for debugging.
    const tap = (label, page) => {
      page.on("console", (msg) => {
        console.log("[" + label + " " + msg.type() + "]", msg.text());
      });
      page.on("pageerror", (err) => {
        console.error("[" + label + " pageerror]", err && err.message ? err.message : err);
      });
    };
    tap("alice", alice.page);
    tap("bob", bob.page);

    // Step 1: signup both accounts. Each unlocks and connects.
    await signup(alice.page, "alice");
    await signup(bob.page, "bob");

    // Step 2: Alice generates an invite code via the UI.
    await gotoContactsTab(alice.page);
    const inviteCode = await generateInviteCode(alice.page);
    assert.ok(inviteCode && inviteCode.startsWith("rez:inv:v2:"),
      "expected v2 invite code, got: " + inviteCode);

    // Step 3: Bob navigates to Contacts and accepts the invite via the UI.
    await gotoContactsTab(bob.page);
    await acceptInvite(bob.page, inviteCode);

    // Step 4: thread rows must appear on BOTH sides (event-driven; the
    // entire bug we fixed was bus events not reaching the renderer).
    await gotoChatsTab(alice.page);
    await waitForThreadRow(alice.page, "alice");
    await gotoChatsTab(bob.page);
    await waitForThreadRow(bob.page, "bob");

    // Step 5: select the thread on both sides.
    await selectFirstThread(alice.page);
    await selectFirstThread(bob.page);

    // Step 6: bidirectional message round-trip via real composer.
    const TXT_A2B = "ui-A2B-" + Date.now();
    await sendMessage(alice.page, TXT_A2B);
    await waitForMessageText(alice.page, TXT_A2B, "alice (own echo)");
    await waitForMessageText(bob.page, TXT_A2B, "bob (received)");

    const TXT_B2A = "ui-B2A-" + Date.now();
    await sendMessage(bob.page, TXT_B2A);
    await waitForMessageText(bob.page, TXT_B2A, "bob (own echo)");
    await waitForMessageText(alice.page, TXT_B2A, "alice (received)");
  });
