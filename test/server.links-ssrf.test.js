import { once } from "node:events";
import { createWebPreviewServer } from "../src/server/app/createWebPreviewServer.js";
import { HttpBridgeClient } from "../src/client/transport/HttpBridgeClient.js";
import { CHAT_BRIDGE_SPEC } from "../src/server/transport/ChatBridge.js";
import { LinksUnfurlParams, LinksUnfurlResult } from "../src/records/index.js";
import test from "node:test";
import assert from "node:assert/strict";
import { ServerLinksService } from "../src/server/services/ServerLinksService.js";

function makeService({ dnsLookupImpl, fetchImpl }) {
  const stored = [];
  const bus = { registerFunction() {} };
  const linkPreviewStore = {
    async get() { return null; },
    async put(preview) { stored.push(preview); },
  };
  return {
    service: new ServerLinksService({
      bus,
      linkPreviewStore,
      dnsLookupImpl,
      fetchImpl,
      logger: { warn() {}, error() {}, log() {} },
    }),
    stored,
  };
}

test("link preview resolves once and carries the exact vetted address into the request", async () => {
  let lookups = 0;
  let requestInit = null;
  const { service } = makeService({
    dnsLookupImpl: async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    fetchImpl: async (url, init) => {
      requestInit = init;
      return new Response("<html><head><title>safe</title></head></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  });

  const result = await service.unfurl({ url: "https://attacker.example/page", forceRefresh: true });
  assert.equal(lookups, 1, "fetch cannot trigger a second service-level DNS decision");
  assert.deepEqual(requestInit.pinnedAddress, { address: "93.184.216.34", family: 4 });
  assert.equal(result.preview.title, "safe");
  assert.equal(result.preview.error, "");
});

test("one private DNS answer rejects the whole preview before HTTP", async () => {
  let fetches = 0;
  const { service } = makeService({
    dnsLookupImpl: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    fetchImpl: async () => {
      fetches += 1;
      return new Response("ok");
    },
  });
  const result = await service.unfurl({ url: "https://attacker.example/page", forceRefresh: true });
  assert.equal(fetches, 0);
  assert.equal(result.preview.error, "rejected_private_ip");
});

test("literal IPv6 is classified without DNS and only a public address is pinned", async () => {
  let lookups = 0;
  let pinnedAddress = null;
  const { service } = makeService({
    dnsLookupImpl: async () => {
      lookups += 1;
      return [];
    },
    fetchImpl: async (url, init) => {
      pinnedAddress = init.pinnedAddress;
      return new Response("<title>ipv6</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  });

  const result = await service.unfurl({ url: "https://[2606:4700:4700::1111]/", forceRefresh: true });
  assert.equal(lookups, 0);
  assert.deepEqual(pinnedAddress, { address: "2606:4700:4700::1111", family: 6 });
  assert.equal(result.preview.title, "ipv6");
});

test("reserved IPv4 and private IPv6 literals are rejected before HTTP", async () => {
  let fetches = 0;
  const makeRejected = (url) => {
    const built = makeService({
      dnsLookupImpl: async () => [],
      fetchImpl: async () => {
        fetches += 1;
        return new Response("unexpected");
      },
    });
    return built.service.unfurl({ url, forceRefresh: true });
  };

  const reserved = await makeRejected("http://255.255.255.255/");
  const privateV6 = await makeRejected("http://[fc00::1]/");
  assert.equal(reserved.preview.error, "rejected_private_ip");
  assert.equal(privateV6.preview.error, "rejected_private_ip");
  assert.equal(fetches, 0);
});

// Audit 2026-09-22 B1: the pinned fetch builds a Fetch Response inside an http
// event-emitter callback. A remote server answering with a status the Response
// constructor rejects (Node accepts 100-999, Response only 200-599) must fail
// the preview, never escape as an uncaught exception that kills the sidecar.
test("an out-of-range HTTP status fails the preview without an uncaught exception", async () => {
  const net = await import("node:net");
  const PUBLIC = "93.184.216.34";
  for (const status of [999, 600, 199]) {
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 " + status + " Weird\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello", "latin1");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    // Route the socket for the vetted public address to the local fake origin,
    // so the real pinned transport runs end to end.
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function patchedConnect(...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options && typeof options === "object" && options.host === PUBLIC) {
        options.host = "127.0.0.1";
        options.port = port;
      }
      return originalConnect.apply(this, args);
    };
    const uncaught = [];
    const onUncaught = (err) => { uncaught.push(err); };
    process.on("uncaughtException", onUncaught);
    try {
      const { service } = makeService({ dnsLookupImpl: async () => [{ address: PUBLIC, family: 4 }] });
      const result = await service.unfurl({ url: "http://attacker.example/", forceRefresh: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(uncaught.length, 0, "status " + status + " escaped: " + uncaught.map((e) => e && e.message).join("; "));
      assert.ok(result && result.preview && result.preview.error, "status " + status + " must fail the preview");
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      net.Socket.prototype.connect = originalConnect;
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

// Hosted human-QA regressions (2026-11-11).
const origin = "https://chat.example";
const wire = (method = "links.unfurl", url = "https://public.example") => JSON.stringify({
  type: "bridge.req", ns: "chat", reqId: "qa", method, params: { url },
});
async function fixture(t, overrides = {}) {
  let fetches = 0;
  const server = createWebPreviewServer({
    origin, logger: { warn() {}, error() {} },
    dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => {
      fetches += 1;
      return new Response('<title>Public preview</title><meta property="og:description" content="Guarded metadata">', { headers: { "Content-Type": "text/html" } });
    }, ...overrides,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = "http://127.0.0.1:" + server.address().port + "/app/previews";
  return {
    endpoint, fetches: () => fetches,
    post: (body = wire(), headers = {}) => fetch(endpoint, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body }),
  };
}

test("web preview bridge returns typed results without sending account credentials", async (t) => {
  const f = await fixture(t);
  let init;
  const client = new HttpBridgeClient({ endpoint: f.endpoint, spec: CHAT_BRIDGE_SPEC, fetchImpl: (url, options) => {
    init = options;
    return fetch(url, { ...options, headers: { ...options.headers, Origin: origin } });
  } });
  t.after(() => client.close());
  const result = await client.call("links.unfurl", new LinksUnfurlParams({ url: "https://public.example" }));
  assert.ok(result instanceof LinksUnfurlResult);
  assert.equal(result.preview.title, "Public preview");
  assert.equal(result.cached, false);
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.deepEqual(Object.keys(init.headers), ["Content-Type"]);
  client.close();
  await assert.rejects(client.call("links.unfurl", new LinksUnfurlParams({ url: "https://public.example" })), /closed/);
});

test("public bridge rejects foreign origins, bodies, malformed frames and account capabilities", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(wire(), { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.post(wire(), { Origin: "" })).status, 403);
  assert.equal((await f.post(wire(), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.post("x".repeat(8193))).status, 413);
  assert.equal((await f.post("{" )).status, 400);
  assert.equal((await fetch(f.endpoint)).status, 405);
  assert.equal((await fetch(f.endpoint + "/other")).status, 404);
  for (const method of ["session.hello", "message.send", "keystore.fetch", "__proto__", "constructor"]) {
    const response = await f.post(wire(method));
    const record = await response.json();
    assert.equal(record.ok, false);
    assert.equal(record.error.message, "Service request failed");
  }
  assert.equal(f.fetches(), 0, "unregistered services cannot execute through public HTTP");
});

test("public preview retains the canonical SSRF and redirect guards", async (t) => {
  const f = await fixture(t);
  for (const url of ["http://127.0.0.1", "http://169.254.169.254/latest/meta-data", "http://user:secret@public.example", "file:///etc/passwd"]) {
    assert.equal((await (await f.post(wire("links.unfurl", url))).json()).ok, false);
  }
  assert.equal(f.fetches(), 0);
  const privateDns = await fixture(t, { dnsLookupImpl: async () => [{ address: "10.0.0.1", family: 4 }] });
  assert.equal((await (await privateDns.post()).json()).data.preview.error, "rejected_private_ip");
  assert.equal(privateDns.fetches(), 0);
  const redirect = await fixture(t, { fetchImpl: async () => new Response("", { status: 302, headers: { Location: "http://127.0.0.1/admin" } }) });
  assert.equal((await (await redirect.post()).json()).data.preview.error, "unsafe_redirect");
});

test("per-IP quota ignores untrusted forwarded addresses", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 30; index += 1) {
    const response = await f.post(wire("not.registered"), { "X-Real-IP": "8.8.8." + (index + 1) });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal((await f.post(wire(), { "X-Real-IP": "1.1.1.1" })).status, 429);
  assert.equal(f.fetches(), 0);
});

test("concurrency admission bounds slow work and recovers after completion", async (t) => {
  const releases = [];
  const f = await fixture(t, { fetchImpl: () => new Promise((resolve) => releases.push(() => resolve(new Response("<title>Recovered</title>", { headers: { "Content-Type": "text/html" } })))) });
  const pending = Array.from({ length: 4 }, () => f.post());
  for (let attempt = 0; releases.length < 4 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    assert.equal(releases.length, 4);
    assert.equal((await f.post()).status, 503);
  } finally {
    for (const release of releases) release();
    await Promise.all(pending.map(async (request) => { const response = await request; assert.equal((await response.json()).data.preview.title, "Recovered"); }));
  }
  const again = f.post();
  for (let attempt = 0; releases.length < 5 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  releases[4]();
  assert.equal((await (await again).json()).ok, true);
});

test("HTTP bridge rejects mismatched or oversized responses and aborts pending work", async () => {
  const params = new LinksUnfurlParams({ url: "https://public.example" });
  const mismatch = new HttpBridgeClient({ endpoint: origin, spec: CHAT_BRIDGE_SPEC, fetchImpl: async () => new Response(JSON.stringify({ type: "bridge.res", ns: "chat", reqId: "wrong", method: "links.unfurl", ok: false })) });
  await assert.rejects(mismatch.call("links.unfurl", params), /mismatch/);
  mismatch.close();
  const oversized = new HttpBridgeClient({ endpoint: origin, spec: CHAT_BRIDGE_SPEC, fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)) });
  await assert.rejects(oversized.call("links.unfurl", params), /too large/);
  oversized.close();
  const pending = new HttpBridgeClient({ endpoint: origin, spec: CHAT_BRIDGE_SPEC, fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  const result = pending.call("links.unfurl", params);
  pending.close();
  await assert.rejects(result, /aborted/);
});

test("HTTP bridge preserves the browser fetch receiver", async () => {
  let receiver;
  const client = new HttpBridgeClient({ endpoint: origin, spec: CHAT_BRIDGE_SPEC, fetchImpl: async function () {
    receiver = this;
    return new Response("", { status: 503 });
  } });
  await assert.rejects(client.call("links.unfurl", new LinksUnfurlParams({ url: "https://public.example" })), /503/);
  assert.equal(receiver, globalThis, "browser fetch requires its global receiver");
  client.close();
});
