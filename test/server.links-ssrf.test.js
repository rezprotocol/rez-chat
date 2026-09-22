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
