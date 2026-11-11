import http from "node:http";
import { ChatServerBus } from "./ChatServerBus.js";
import { ChatBridge, CHAT_BRIDGE_METHOD_BINDINGS } from "../transport/ChatBridge.js";
import { ChatHttpUplink } from "../transport/ChatHttpUplink.js";
import { ServerLinksService } from "../services/ServerLinksService.js";
import { WEB_PREVIEW_PATH } from "../config/webPreview.js";

// Public metadata only: this bus contains no identity, keys, messages, storage,
// node session or account service. Capability exposure follows registered bus
// functions and the canonical bridge spec, never a transport directive list.
export function createWebPreviewServer({ origin, trustedProxies = [], logger = console, fetchImpl = null, dnsLookupImpl } = {}) {
  const bus = new ChatServerBus({ logger });
  new ServerLinksService({ bus, cacheEnabled: false, ownerAccountId: "public-web-previews", logger, fetchImpl, dnsLookupImpl });
  const bridge = new ChatBridge({ bus, ownerAccountId: "public-web-previews", logger });
  const canonical = bridge.getSpec();
  const methods = Object.create(null);
  for (const [method, binding] of Object.entries(CHAT_BRIDGE_METHOD_BINDINGS)) {
    const bucket = bus.functions[binding.namespace];
    if (bucket && Object.hasOwn(bucket, binding.name) && typeof bucket[binding.name] === "function") methods[method] = canonical.methods[method];
  }
  const uplink = new ChatHttpUplink({
    bridge, spec: { namespace: canonical.namespace, methods, events: {} },
    origin, path: WEB_PREVIEW_PATH, trustedProxies,
  });
  return http.createServer({ headersTimeout: 5000, requestTimeout: 10000, maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, (req, res) => {
    uplink.handle(req, res).catch((err) => {
      logger.error("Web preview transport failed", err && err.name);
      res.destroy();
    });
  });
}
