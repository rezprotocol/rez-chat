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

function imageStatus(page, caption, status) {
  const bubble = page.getByTestId("message.bubble").filter({ has: page.getByTestId("message.text").filter({ hasText: caption }) });
  return bubble.locator("..").locator("[data-testid='message.status'][data-message-status='" + status + "']");
}

async function pauseAfterFirstChunk(page) {
  // Observe commit completion without reading any account keys or file bytes.
  await page.addInitScript(() => {
    globalThis.__hostedChunkCommits = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (String(key).includes("/xfer-chunk:")) {
        this.transaction.addEventListener("complete", () => { globalThis.__hostedChunkCommits += 1; });
      }
      return request;
    };
  });
  let firstPage = null;
  let acknowledged = false;
  let heldPages = 0;
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      let frame;
      try { frame = JSON.parse(String(message)); } catch { socket.send(message); return; }
      const body = frame.body;
      if (frame.t === "mailbox.list.res" && body && Array.isArray(body.items)) {
        if (firstPage && body.mailboxId === firstPage.mailboxId) {
          heldPages += 1;
          return;
        }
        const chunks = body.items.filter((item) => typeof item.ciphertextB64 === "string" && item.ciphertextB64.length > 100_000);
        if (chunks.length) firstPage = { mailboxId: body.mailboxId, throughSeq: Math.max(...chunks.map((item) => item.seq)) };
      }
      if (frame.t === "mailbox.cursorAck.res" && firstPage && body
        && body.mailboxId === firstPage.mailboxId && body.lastSeq >= firstPage.throughSeq) acknowledged = true;
      socket.send(message);
    });
  });
  return {
    async waitForDurablePage() {
      await page.waitForFunction(() => globalThis.__hostedChunkCommits > 0, null, { timeout: 20_000 });
      const deadline = Date.now() + 10_000;
      while ((!acknowledged || heldPages === 0) && Date.now() < deadline) await page.waitForTimeout(50);
      assert.ok(acknowledged, "server must acknowledge the consumed first chunk page before interruption");
      assert.ok(heldPages > 0, "later mailbox pages must remain blocked during the responsiveness check");
      return firstPage;
    },
  };
}

test("hosted web app: responsive catch-up + interrupted image recovery + reply", { timeout: 180_000 }, async (t) => {
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
  const duringSyncText = "HOSTED WEB DURING SYNC " + suffix;

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
  await imageStatus(alice, imageText, "sent").waitFor({ state: "visible", timeout: 10_000 });
  // Discard the sender's in-memory acknowledgement map before delivery.
  await unlockAccount(alice, alicePassword);
  await alice.getByTestId("nav.chat").click();
  await alice.getByTestId("thread.row").click();
  await imageStatus(alice, imageText, "sent").waitFor({ state: "visible", timeout: 10_000 });
  console.log("[receipt-proof] offline image remains Sent across sender refresh");

  bob = await bobContext.newPage();
  await observePage(bob, "bob-reopened");
  const paused = await pauseAfterFirstChunk(bob);
  const unlockStarted = Date.now();
  await unlockAccount(bob, bobPassword);
  console.log("[recovery-proof] unlock to usable chat ms=" + (Date.now() - unlockStarted));
  await bob.getByTestId("thread.row").waitFor({ state: "visible", timeout: 45_000 });
  await bob.getByTestId("thread.row").click();
  const consumedPage = await paused.waitForDurablePage();
  assert.equal(await bob.getByRole("img", { name: fileName, exact: true }).count(), 0,
    "the image must still be incomplete when chat becomes usable");
  await bob.getByTestId("composer.input").fill(duringSyncText);
  await bob.getByTestId("composer.send").click();
  await alice.getByTestId("message.text").filter({ hasText: duringSyncText })
    .waitFor({ state: "visible", timeout: 10_000 });
  console.log("[recovery-proof] message sent while later image pages remain blocked");
  await bob.close();

  // Keep the same context/IndexedDB, but discard every in-memory transfer.
  // The consumed first page must NOT be redelivered to make recovery work.
  bob = await bobContext.newPage();
  await observePage(bob, "bob-interrupted");
  let replayedConsumedChunk = false;
  bob.on("websocket", (socket) => socket.on("framereceived", (event) => {
    let frame;
    try { frame = JSON.parse(String(event.payload)); } catch { return; }
    if (frame.t === "mailbox.list.res" && frame.body && frame.body.mailboxId === consumedPage.mailboxId) {
      replayedConsumedChunk = replayedConsumedChunk || frame.body.items.some((item) => item.seq <= consumedPage.throughSeq
        && typeof item.ciphertextB64 === "string" && item.ciphertextB64.length > 100_000);
    }
  }));
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
  assert.equal(replayedConsumedChunk, false, "reassembly must use committed local chunks, not replay of the consumed page");
  console.log("[recovery-proof] exact image bytes and decoded dimensions recovered after interruption");
  await imageStatus(alice, imageText, "delivered").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await bob.getByRole("img", { name: fileName, exact: true }).count(), 1);
  console.log("[receipt-proof] original sender image changes to Delivered after receiver recovery");

  await bob.getByTestId("composer.input").fill(replyText);
  await bob.getByTestId("composer.send").click();
  await alice.getByTestId("message.text").filter({ hasText: replyText })
    .waitFor({ state: "visible", timeout: 60_000 });
  await unlockAccount(alice, alicePassword);
  await alice.getByTestId("nav.chat").click();
  await alice.getByTestId("thread.row").click();
  await imageStatus(alice, imageText, "delivered").waitFor({ state: "visible", timeout: 10_000 });
  console.log("[receipt-proof] Delivered survives another sender refresh");
});
