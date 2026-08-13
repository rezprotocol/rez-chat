import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const hostedUrl = String(process.env.REZ_HOSTED_CHAT_URL || "").trim();
const chromePath = String(process.env.CHROME_PATH || "").trim();
if (!hostedUrl) throw new Error("REZ_HOSTED_CHAT_URL is required");
if (!chromePath) throw new Error("CHROME_PATH is required");

async function waitConnected(page) {
  await page.waitForFunction(() => {
    const dot = document.querySelector("[data-role='connection-status-dot']");
    const tone = dot ? String(dot.getAttribute("data-tone") || "") : "";
    return tone === "connected" || tone === "connected-local";
  }, null, { timeout: 45_000 });
}

async function closeRecoveryPhrase(page) {
  const heading = page.getByRole("heading", { name: "Your recovery phrase" });
  await heading.waitFor({ state: "visible", timeout: 20_000 });
  const words = await page.locator("text=/^[0-9]+\\.$/").count();
  assert.equal(words, 24, "new hosted browser accounts must display 24 recovery words");
  const acknowledge = page.locator("button[data-role='ack']");
  await acknowledge.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector("button[data-role='ack']");
    return !!button && button.disabled === false;
  }, null, { timeout: 10_000 });
  await acknowledge.click();
}

async function createAccount(page, name, password) {
  await page.goto(hostedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("[data-role='signup-name']").fill(name);
  await page.locator("[data-role='signup-password']").fill(password);
  await page.locator("[data-role='signup-confirm']").fill(password);
  await page.locator("button[data-action='session.create']").click();
  await page.getByTestId("nav.contacts").waitFor({ state: "visible", timeout: 45_000 });
  await closeRecoveryPhrase(page);
  await waitConnected(page);
}

async function unlockAccount(page, password) {
  await page.goto(hostedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("[data-role='unlock-password']").fill(password);
  await page.locator("button[data-action='session.unlock']").click();
  await page.getByTestId("nav.contacts").waitFor({ state: "visible", timeout: 45_000 });
  await waitConnected(page);
}

async function observePage(page, label) {
  await page.addInitScript((pageLabel) => {
    globalThis.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const detail = reason && reason.stack ? reason.stack : String(reason);
      console.error("[hosted-e2e:" + pageLabel + ":unhandledrejection] " + detail);
    });
  }, label);
  page.on("console", (message) => {
    console.log("[hosted-e2e:" + label + ":console:" + message.type() + "] " + message.text());
  });
  page.on("pageerror", (error) => {
    console.error("[hosted-e2e:" + label + ":pageerror] " + error.stack);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    console.error("[hosted-e2e:" + label + ":requestfailed] " + request.url()
      + " " + (failure ? failure.errorText : "unknown"));
  });
}

test("hosted web app: PWA + two-browser invite + offline durable catch-up", { timeout: 180_000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  t.after(() => browser.close());
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  t.after(() => aliceContext.close());
  t.after(() => bobContext.close());
  const alice = await aliceContext.newPage();
  let bob = await bobContext.newPage();
  await Promise.all([
    observePage(alice, "alice"),
    observePage(bob, "bob"),
  ]);
  const suffix = String(Date.now());
  const alicePassword = "hosted-alice-" + suffix;
  const bobPassword = "hosted-bob-" + suffix;
  const offlineText = "HOSTED WEB OFFLINE " + suffix;

  await Promise.all([
    createAccount(alice, "Hosted Alice " + suffix, alicePassword),
    createAccount(bob, "Hosted Bob " + suffix, bobPassword),
  ]);

  const manifest = await alice.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest", { cache: "no-store" });
    return response.json();
  });
  assert.equal(manifest.display, "standalone");
  await alice.evaluate(() => navigator.serviceWorker.ready.then(() => true));

  await alice.getByTestId("nav.contacts").click();
  await alice.getByTestId("invite.create.direct.button").click();
  const inviteCode = String(await alice.getByTestId("invite.lastCreated.code").textContent({ timeout: 30_000 }) || "").trim();
  assert.ok(inviteCode.length > 20, "hosted invite code must be populated");

  await bob.getByTestId("nav.contacts").click();
  await bob.getByTestId("invite.accept.input").fill(inviteCode);
  await bob.getByTestId("invite.accept.button").click();
  await bob.getByTestId("thread.row").waitFor({ state: "visible", timeout: 45_000 });
  await alice.getByText("Hosted Bob " + suffix, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  await alice.getByTestId("nav.chat").click();
  await alice.getByTestId("thread.row").waitFor({ state: "visible", timeout: 45_000 });

  await bob.close();
  await alice.getByTestId("thread.row").click();
  await alice.getByTestId("composer.input").fill(offlineText);
  await alice.getByTestId("composer.send").click();
  await alice.getByText(offlineText, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  bob = await bobContext.newPage();
  await observePage(bob, "bob-reopened");
  await unlockAccount(bob, bobPassword);
  await bob.getByTestId("thread.row").waitFor({ state: "visible", timeout: 45_000 });
  await bob.getByTestId("thread.row").click();
  await bob.getByText(offlineText, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
});
