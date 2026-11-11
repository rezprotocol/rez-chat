import net from "node:net";
import { BridgeRequest, BridgeResponse, BridgeRouter } from "@rezprotocol/sdk/client";
import { SlidingWindowRateLimiter } from "@rezprotocol/node";

// A bounded, request-only HTTP transport. The composition root must supply a
// restricted bridge: this transport has no session or directive allowlist.
export class ChatHttpUplink {
  #bridge;
  #router = new BridgeRouter();
  #origin;
  #path;
  #trustedProxies;
  #active = 0;
  #limiter = new SlidingWindowRateLimiter({ windowMs: 60000, maxAttempts: 30, lruCap: 4096 });

  constructor({ bridge, spec = bridge.getSpec(), origin, path, trustedProxies = [] } = {}) {
    this.#bridge = bridge;
    this.#router.register(spec);
    this.#origin = new URL(origin).origin;
    this.#path = path;
    this.#trustedProxies = new Set(trustedProxies);
  }

  async handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.url !== this.#path) return this.#reject(res, 404);
    if (req.method !== "POST") return this.#reject(res, 405);
    if (req.headers.origin !== this.#origin) return this.#reject(res, 403);
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return this.#reject(res, 415);
    const address = req.socket.remoteAddress;
    const forwarded = req.headers["x-real-ip"];
    const ip = this.#trustedProxies.has(address) && typeof forwarded === "string" && net.isIP(forwarded) ? forwarded : address;
    if (!this.#limiter.record(ip, Date.now())) return this.#reject(res, 429);
    if (this.#active >= 4) return this.#reject(res, 503);
    if (Number(req.headers["content-length"]) > 8192) return this.#reject(res, 413);
    this.#active += 1;
    let frame = null;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) return this.#reject(res, 413);
        chunks.push(chunk);
      }
      frame = this.#router.parseFrame(Buffer.concat(chunks).toString("utf8"));
      if (!(frame instanceof BridgeRequest)) throw new Error("request required");
      const spec = this.#router.getBridge(frame.ns);
      if (!spec || !Object.hasOwn(spec.methods, frame.method)) throw new Error("unavailable method");
      const params = this.#router.rehydrateParams(frame);
      const result = await this.#bridge.handle(null, frame.method, params);
      this.#send(res, new BridgeResponse({ ns: frame.ns, reqId: frame.reqId, method: frame.method, ok: true, data: result.toJSON() }));
    } catch {
      if (frame instanceof BridgeRequest) {
        this.#send(res, new BridgeResponse({ ns: frame.ns, reqId: frame.reqId, method: frame.method, ok: false,
          error: { code: "REQUEST_FAILED", message: "Service request failed" } }));
      } else this.#reject(res, 400);
    } finally {
      this.#active -= 1;
    }
  }

  #reject(res, status) {
    res.writeHead(status, { "Content-Type": "text/plain", "Connection": "close" });
    res.end("Request rejected");
  }

  #send(res, frame) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: frame.type, ...frame.toJSON() }));
  }
}
