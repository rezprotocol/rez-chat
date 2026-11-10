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

async function makeLargeImage(page) {
  // Use the browser's PNG encoder so this checks real rendering as well as
  // byte recovery. Noise keeps a 700x700 image above one transport frame.
  const b64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 700;
    const context = canvas.getContext("2d");
    const image = context.createImageData(700, 700);
    for (let offset = 0; offset < image.data.length; offset += 65536) {
      crypto.getRandomValues(image.data.subarray(offset, offset + 65536));
    }
    for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  assert.ok(Buffer.from(b64, "base64").length > 1_000_000);
  return b64;
}

test("hosted web app: PWA + invite + offline text/image catch-up + reply", { timeout: 180_000 }, async (t) => {
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
  const replyText = "HOSTED WEB REPLY " + suffix;
  const imageText = "HOSTED WEB IMAGE " + suffix;

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
  await alice.getByTestId("message.text").filter({ hasText: offlineText })
    .waitFor({ state: "visible", timeout: 30_000 });

  const imageB64 = await makeLargeImage(alice);
  const fileName = "hosted-acceptance.png";
  const chooserPromise = alice.waitForEvent("filechooser");
  await alice.getByRole("button", { name: "Attach file", exact: true }).click();
  await (await chooserPromise).setFiles({ name: fileName, mimeType: "image/png", buffer: Buffer.from(imageB64, "base64") });
  await alice.getByText(fileName, { exact: true }).waitFor({ state: "visible" });
  await alice.getByTestId("composer.input").fill(imageText);
  await alice.getByTestId("composer.send").click();
  await alice.getByTestId("message.text").filter({ hasText: imageText })
    .waitFor({ state: "visible", timeout: 60_000 });

  bob = await bobContext.newPage();
  await observePage(bob, "bob-reopened");
  await unlockAccount(bob, bobPassword);
  await bob.getByTestId("thread.row").waitFor({ state: "visible", timeout: 45_000 });
  await bob.getByTestId("thread.row").click();
  await bob.getByTestId("message.text").filter({ hasText: offlineText })
    .waitFor({ state: "visible", timeout: 60_000 });
  const receivedImage = bob.getByRole("img", { name: fileName, exact: true });
  await receivedImage.waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await receivedImage.getAttribute("src"), "data:image/png;base64," + imageB64,
    "offline image bytes must survive mailbox paging exactly");
  await bob.waitForFunction((name) => {
    const images = [...document.querySelectorAll("img")];
    const image = images.find((element) => element.alt === name);
    return image && image.complete && image.naturalWidth === 700 && image.naturalHeight === 700;
  }, fileName, { timeout: 30_000 });

  await bob.getByTestId("composer.input").fill(replyText);
  await bob.getByTestId("composer.send").click();
  await alice.getByTestId("message.text").filter({ hasText: replyText })
    .waitFor({ state: "visible", timeout: 60_000 });
});
