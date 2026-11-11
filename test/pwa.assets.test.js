import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { BrowserUpdateService, browserEntryUrl } from "../src/ui/services/BrowserUpdateService.js";
import { BrowserUpdateBannerView } from "../src/ui/views/BrowserUpdateBannerView.js";
import { FakeElement, installFakeDom, fakeEvent } from "./_helpers/fakeDom.js";

const root = path.resolve(import.meta.dirname, "..");

test("production build emits an installable manifest, service worker, and canonical icons", async () => {
  const out = path.join(root, "artifacts", "rez-chat");
  const manifest = JSON.parse(await readFile(path.join(out, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.deepEqual(manifest.icons.map((icon) => icon.src), [
    "/icons/rez-chat-256.png",
    "/icons/rez-chat-1024.png",
  ]);
  await access(path.join(out, "sw.js"));
  await access(path.join(out, "icons", "rez-chat-256.png"));
  await access(path.join(out, "icons", "rez-chat-1024.png"));
});

test("service worker keeps live protocol endpoints network-owned", async () => {
  const source = await readFile(path.join(root, "public", "sw.js"), "utf8");
  for (const pathName of ["/ws", "/config", "/health", "/ready"]) {
    assert.match(source, new RegExp("\\\"" + pathName + "\\\""));
  }
});

const ORIGIN = "https://chat.example";
const ENTRY_A = ORIGIN + "/assets/index-aaaaaaaa.js";
const ENTRY_B = ORIGIN + "/assets/index-bbbbbbbb.js";
const shell = (entry) => '<!doctype html><script type="module" crossorigin src="' + entry + '"></script>';
const htmlResponse = (entry) => new Response(shell(entry), { headers: { "content-type": "text/html; charset=utf-8" } });

class TestWindow extends EventTarget {
  location = new URL(ORIGIN + "/");
  timers = new Map();
  #nextTimer = 0;
  setTimeout(fn, delay) { const id = ++this.#nextTimer; this.timers.set(id, { fn, delay }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  fire(delay) {
    const timer = [...this.timers.entries()].find(([, entry]) => entry.delay === delay);
    assert.ok(timer, "expected timer with delay " + delay);
    this.timers.delete(timer[0]);
    timer[1].fn();
  }
}

class TestDocument extends EventTarget {
  visibilityState = "visible";
  querySelector() { return { src: ENTRY_A }; }
}

function updateFixture(t) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const win = new TestWindow();
  const doc = new TestDocument();
  const updates = [];
  const requests = [];
  let respond = async () => htmlResponse(ENTRY_A);
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.fetch = async (...args) => { requests.push(args); return respond(...args); };
  const service = new BrowserUpdateService((entry) => updates.push(entry));
  t.after(() => {
    service.stop();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });
  return { service, win, doc, updates, requests, respond(fn) { respond = fn; } };
}

test("browser update identity comes from the generated same-origin module entry", () => {
  assert.equal(browserEntryUrl(shell("/assets/index-bbbbbbbb.js"), ORIGIN), ENTRY_B);
  assert.equal(browserEntryUrl("<script src='/assets/index-bbbbbbbb.js' type='module'></script>", ORIGIN), ENTRY_B);
  for (const markup of [shell("https://elsewhere.example/assets/index-bbbbbbbb.js"), shell("/src/main.js"), shell("/assets/index-bbbbbbbb.js?changed"), "<script data-src='/assets/index-bbbbbbbb.js' type='module'></script>", "not html", "x".repeat(262145)]) {
    assert.equal(browserEntryUrl(markup, ORIGIN), "");
  }
});

test("browser checks bypass caches, omit credentials and detect the next build on the minute timer", async (t) => {
  const f = updateFixture(t);
  assert.equal(f.service.start(), true);
  await f.service.check();
  assert.equal(f.updates.at(-1), "");
  const [url, options] = f.requests[0];
  assert.equal(new URL(url).pathname, "/");
  assert.ok(new URL(url).searchParams.has("__rez_update_check"));
  assert.equal(options.cache, "no-store");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  f.respond(async () => htmlResponse(ENTRY_B));
  f.win.fire(60000);
  await f.service.check();
  assert.equal(f.updates.at(-1), ENTRY_B);
  assert.notEqual(f.requests[0][0], f.requests[1][0], "even the previous service worker cannot reuse its probe response");
  f.respond(async () => htmlResponse(ENTRY_A));
  await f.service.check();
  assert.equal(f.updates.at(-1), "", "rollback to the running build clears the notice");
});

test("hidden tabs stop polling; visibility, focus and reconnect wake a coalesced check", async (t) => {
  const f = updateFixture(t);
  f.service.start(); await f.service.check();
  f.doc.visibilityState = "hidden";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.win.timers.size, 0);
  f.win.dispatchEvent(new Event("focus"));
  await f.service.check();
  assert.equal(f.requests.length, 1);
  let resolve;
  f.respond(() => new Promise((done) => { resolve = done; }));
  f.doc.visibilityState = "visible";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.win.dispatchEvent(new Event("focus"));
  f.win.dispatchEvent(new Event("online"));
  assert.equal(f.requests.length, 2, "simultaneous lifecycle wakeups share a request");
  resolve(htmlResponse(ENTRY_B));
  await f.service.check();
  assert.equal(f.updates.at(-1), ENTRY_B);
});

test("stopping aborts checks and prevents late responses or timers from announcing an update", async (t) => {
  const f = updateFixture(t);
  let resolve;
  f.respond(() => new Promise((done) => { resolve = done; }));
  f.service.start();
  const pending = f.service.check();
  const signal = f.requests[0][1].signal;
  f.service.stop();
  assert.equal(signal.aborted, true);
  resolve(htmlResponse(ENTRY_B)); await pending;
  assert.equal(f.updates.at(-1), "");
  assert.equal(f.win.timers.size, 0);
  f.win.dispatchEvent(new Event("online"));
  assert.equal(f.requests.length, 1);
});

test("a stopped check cannot overwrite the result or timer of a restarted monitor", async (t) => {
  const f = updateFixture(t);
  let resolve;
  f.respond(() => new Promise((done) => { resolve = done; }));
  f.service.start(); const old = f.service.check();
  f.service.stop();
  f.respond(async () => htmlResponse(ENTRY_B));
  f.service.start(); await f.service.check();
  resolve(htmlResponse(ENTRY_A)); await old;
  assert.equal(f.updates.at(-1), ENTRY_B);
  assert.equal([...f.win.timers.values()].filter((timer) => timer.delay === 60000).length, 1);
});

test("an in-flight response does not show a banner while hidden; returning checks again", async (t) => {
  const f = updateFixture(t);
  let resolve;
  f.respond(() => new Promise((done) => { resolve = done; }));
  f.service.start(); const pending = f.service.check();
  f.doc.visibilityState = "hidden";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  resolve(htmlResponse(ENTRY_B)); await pending;
  assert.equal(f.updates.at(-1), "");
  assert.equal(f.win.timers.size, 0);
  f.respond(async () => htmlResponse(ENTRY_B));
  f.doc.visibilityState = "visible";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  await f.service.check();
  assert.equal(f.updates.at(-1), ENTRY_B);
});

test("offline, malformed and failed checks cannot announce an update and retry normally", async (t) => {
  const f = updateFixture(t);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; });
  f.respond(async () => { throw new Error("offline"); });
  f.service.start(); await f.service.check();
  assert.equal(warnings.length, 1);
  await f.service.check();
  assert.equal(warnings.length, 1, "a repeated outage does not flood the console");
  f.respond(async () => new Response("unavailable", { status: 503 }));
  await f.service.check();
  f.respond(async () => new Response(shell(ENTRY_B), { headers: { "content-type": "application/json" } }));
  await f.service.check();
  f.respond(async () => new Response("<html>maintenance</html>", { headers: { "content-type": "text/html" } }));
  await f.service.check();
  assert.ok(f.updates.every((entry) => entry === ""));
  f.respond(async () => htmlResponse(ENTRY_B));
  await f.service.check();
  assert.equal(f.updates.at(-1), ENTRY_B);
});

test("a timed-out check cannot publish a late response; development and native URLs do not poll", async (t) => {
  const f = updateFixture(t);
  let resolve;
  f.respond(() => new Promise((done) => { resolve = done; }));
  f.service.start(); const pending = f.service.check();
  f.win.fire(10000);
  assert.equal(f.requests[0][1].signal.aborted, true);
  resolve(htmlResponse(ENTRY_B)); await pending;
  assert.equal(f.updates.at(-1), "");
  f.service.stop();
  assert.equal(f.service.start(ORIGIN + "/src/main.js"), false);
  f.win.location = new URL("file:///app/index.html");
  assert.equal(f.service.start(ENTRY_A), false);
  assert.equal(f.requests.length, 1);
});

test("service worker never serves or stores browser-update probes in the shell cache", async () => {
  const handlers = new Map();
  const source = await readFile(path.join(root, "public", "sw.js"), "utf8");
  vm.runInNewContext(source, { self: { location: new URL(ORIGIN), addEventListener: (name, fn) => handlers.set(name, fn) }, URL });
  for (const [url, cache] of [[ORIGIN + "/", "no-store"], [ORIGIN + "/?__rez_update_check=1", "default"]]) {
    let intercepted = false;
    handlers.get("fetch")({ request: { method: "GET", url, cache }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

class UpdateTestElement extends FakeElement {
  get childElementCount() { return this.children.filter((child) => child instanceof FakeElement).length; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}

function bannerFixture(t) {
  const saved = [globalThis.Node, globalThis.Element, globalThis.document, globalThis.window];
  installFakeDom();
  document.body = new UpdateTestElement("body");
  document.createElement = (tag) => new UpdateTestElement(tag);
  document.querySelector = (selector) => document.body.querySelector(selector);
  let reloads = 0;
  const confirmations = [];
  globalThis.window = {
    location: { reload() { reloads++; } },
    confirm(message) { confirmations.push(message); return false; },
  };
  const banner = new BrowserUpdateBannerView();
  t.after(() => {
    banner.stop();
    [globalThis.Node, globalThis.Element, globalThis.document, globalThis.window] = saved;
  });
  return { banner, confirmations, reloads: () => reloads, button: (name) => document.querySelector('[data-testid="browserUpdate.' + name + '"]') };
}

test("browser update notice never reloads automatically; Later suppresses that build, not the next one", (t) => {
  const f = bannerFixture(t);
  f.banner.setUpdate(ENTRY_B);
  assert.equal(f.reloads(), 0);
  assert.equal(document.querySelector('[data-testid="browserUpdate.banner"]').attributes.get("role"), "status");
  f.button("later").dispatchEvent(fakeEvent("click"));
  f.banner.setUpdate(ENTRY_B);
  assert.equal(f.button("refresh"), null);
  f.banner.setUpdate(ORIGIN + "/assets/index-cccccccc.js");
  assert.ok(f.button("refresh"));
  f.banner.setUpdate("");
  assert.equal(f.button("refresh"), null);
  f.banner.setUpdate(ENTRY_B);
  f.button("refresh").dispatchEvent(fakeEvent("click"));
  assert.equal(f.reloads(), 1);
  assert.equal(f.confirmations.length, 0, "an empty composer does not prompt");
});

test("browser Refresh confirms actual unsent text and attachments; cancellation preserves both", (t) => {
  const f = bannerFixture(t);
  const input = document.createElement("textarea");
  input.setAttribute("data-testid", "composer.input");
  input.value = "keep this draft";
  document.body.appendChild(input);
  const attachment = document.createElement("div");
  attachment.setAttribute("data-testid", "composer.attachment");
  attachment.appendChild(document.createElement("img"));
  document.body.appendChild(attachment);
  f.banner.setUpdate(ENTRY_B);
  f.button("refresh").dispatchEvent(fakeEvent("click"));
  assert.equal(f.reloads(), 0);
  assert.equal(input.value, "keep this draft");
  assert.equal(attachment.childElementCount, 1);
  input.value = "";
  f.button("refresh").dispatchEvent(fakeEvent("click"));
  assert.equal(f.confirmations.length, 2, "an attachment alone also requires confirmation");
  assert.equal(f.reloads(), 0);
  window.confirm = () => true;
  f.button("refresh").dispatchEvent(fakeEvent("click"));
  assert.equal(f.reloads(), 1);
});
