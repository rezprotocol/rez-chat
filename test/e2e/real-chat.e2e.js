import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";

import { startRezChat } from "../../src/index.js";
import { newDefaultThreadId } from "../../src/server/config/defaultRezConfig.js";
import { createTempRezChatConfig } from "../_configUtil.js";
import { isBindPermissionError } from "../_lifecycleUtil.js";

function ensurePlaywrightPlatformOverride() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || cpus.length > 0) return;
  if (!process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
    process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "mac15-arm64";
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function startEphemeralStack(t, { threadId } = {}) {
  const wsPort = await getFreePort();
  const shellPort = await getFreePort();
  const fixture = await createTempRezChatConfig({
    prefix: "rez-chat-e2e-",
    wsPort,
    defaultThreadId: String(threadId),
  });

  let app;
  try {
    app = await startRezChat({
      configPath: fixture.configPath,
      shellPort,
      shellHost: "127.0.0.1",
    });
  } catch (err) {
    await fixture.cleanup();
    if (isBindPermissionError(err)) {
      t.skip("TCP/HTTP bind not permitted in this environment");
      return null;
    }
    throw err;
  }

  if (threadId && app?.nodeApp?.chatStore && app?.nodeApp?.runtime) {
    const localInboxId = app.nodeApp.runtime.getIdentity().localInboxId;
    await app.nodeApp.chatStore.ensureThread({
      threadId,
      title: "E2E",
      peerInboxId: localInboxId,
      kind: "dm",
    });
    const listing = await app.nodeApp.chatStore.listThreads({ limit: 100 });
    const hasSeeded = Array.isArray(listing?.threads) && listing.threads.some((row) => row.threadId === threadId);
    if (!hasSeeded) {
      await app.nodeApp.chatStore.createThread({
        threadId,
        title: "E2E",
        peerInboxId: localInboxId,
        kind: "dm",
      });
    }
  }

  const shellUrl = `http://127.0.0.1:${app.shell.address.port}`;
  return {
    shellUrl,
    async stop() {
      await app.stop().catch(() => {});
      await fixture.cleanup();
    },
  };
}

async function getThreadIds(page) {
  return await page.evaluate(() => {
    const nodes = document.querySelectorAll("[data-role='threads'] [data-thread-id]");
    return Array.from(nodes).map((node) => String(node.getAttribute("data-thread-id") || "").trim()).filter(Boolean);
  });
}

async function connectClient(page, preferredThreadId = "") {
  const signupInput = page.locator("[data-role='signup-input']");
  if (await signupInput.count()) {
    const profileName = `E2E ${Math.random().toString(16).slice(2, 8)}`;
    const testPassword = "testpass123";
    await signupInput.fill(profileName);
    await page.locator("[data-role='signup-password']").fill(testPassword);
    await page.locator("[data-role='signup-confirm']").fill(testPassword);
    await page.locator("[data-role='signup-btn']").click();
  }

  const alreadyReady = await page.evaluate(() => {
    const statusEl = document.querySelector("[data-role='status']");
    const text = String(statusEl?.textContent || "");
    return text.includes("session=ready") && text.includes("connection=connected");
  });

  if (!alreadyReady) {
    const connectBtn = page.locator("[data-role='connect-btn']:not([disabled])");
    if (await connectBtn.count()) {
      await page.locator("[data-role='unlock-password']").fill("testpass123");
      await connectBtn.click();
    }
  }
  await page.waitForFunction(() => {
    const statusEl = document.querySelector("[data-role='status']");
    const text = String(statusEl?.textContent || "");
    return text.includes("session=ready") && text.includes("connection=connected");
  }, { timeout: 15000 });

  const deadline = Date.now() + 15000;
  let ids = [];
  while (Date.now() < deadline) {
    ids = await getThreadIds(page);
    if (ids.length > 0) break;
    await page.waitForTimeout(100);
  }
  if (ids.length === 0) {
    const statusText = await page.locator("[data-role='status']").textContent();
    throw new Error(`No threads rendered after connect. status=${String(statusText || "").trim()}`);
  }

  const selectedId = preferredThreadId && ids.includes(preferredThreadId) ? preferredThreadId : ids[0];
  await page.locator(`[data-role='threads'] [data-thread-id='${selectedId}']`).first().click();
  await page.waitForFunction(() => {
    const title = String(document.querySelector("[data-role='thread-title']")?.textContent || "");
    return title.trim().length > 0 && title !== "No thread selected";
  }, { timeout: 10000 });
  return selectedId;
}

async function waitForMessageNonce(page, nonce) {
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll("[data-role='messages'] [data-msg-id]");
    return Array.from(nodes).some((node) => String(node.textContent || "").includes(needle));
  }, nonce, { timeout: 20000 });
}

test("real-chat e2e: two browser clients exchange Rez payload over live runtime", { skip: !process.env.RUN_E2E }, async (t) => {
  ensurePlaywrightPlatformOverride();

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    t.skip("Playwright not installed; run: npm -C rez-chat install --save-dev playwright");
    return;
  }

  const externalShellUrl = String(process.env.REZ_E2E_SHELL_URL || "").trim();
  let stack = null;
  let shellUrl = externalShellUrl;
  const threadId = newDefaultThreadId();
  if (!shellUrl) {
    stack = await startEphemeralStack(t, { threadId });
    if (!stack) return;
    shellUrl = stack.shellUrl;
    t.after(async () => {
      await stack.stop();
    });
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await Promise.all([
      pageA.goto(shellUrl, { waitUntil: "domcontentloaded", timeout: 15000 }),
      pageB.goto(shellUrl, { waitUntil: "domcontentloaded", timeout: 15000 }),
    ]);

    const selectedThreadA = await connectClient(pageA, threadId);
    const selectedThreadB = await connectClient(pageB, selectedThreadA);
    assert.equal(selectedThreadB, selectedThreadA, "both clients must target the same thread");

    const nonce = `rez-e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const payload = JSON.stringify({ kind: "rez.e2e", nonce, from: "client-a" });
    await pageA.locator("[data-role='composer-input']").fill(payload);
    await pageA.locator("[data-role='composer'] button[data-action='message.send']").click();

    await Promise.all([waitForMessageNonce(pageA, nonce), waitForMessageNonce(pageB, nonce)]);
    assert.ok(true, `both clients observed nonce ${nonce}`);

    await Promise.all([contextA.close(), contextB.close()]);
  } finally {
    await browser.close();
  }
});
