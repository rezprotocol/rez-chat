import { BridgeRequest, BridgeResponse, BridgeRouter } from "@rezprotocol/sdk/client";

// Request/response only. No account credentials or session events cross this
// bridge; the composition root supplies its restricted service spec.
export class HttpBridgeClient {
  #endpoint;
  #spec;
  #router = new BridgeRouter();
  #fetch;
  #pending = new Set();
  #counter = 0;
  #closed = false;

  constructor({ endpoint, spec, fetchImpl = globalThis.fetch } = {}) {
    this.#endpoint = new URL(endpoint).href;
    this.#router.register(spec);
    this.#spec = spec;
    if (typeof fetchImpl !== "function") throw new Error("HttpBridgeClient requires fetch");
    this.#fetch = fetchImpl.bind(globalThis);
  }

  async call(method, params) {
    if (this.#closed) throw new Error("HTTP bridge closed");
    const methodSpec = Object.hasOwn(this.#spec.methods, method) ? this.#spec.methods[method] : null;
    if (!methodSpec || !(params instanceof methodSpec.params)) throw new Error("HTTP bridge requires registered method and parameter record");
    params.validate();
    const request = new BridgeRequest({ ns: this.#spec.namespace, reqId: String(++this.#counter), method, params: params.toJSON() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    this.#pending.add(controller);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: request.type, ...request.toJSON() }), signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP bridge unavailable (" + response.status + ")");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) throw new Error("HTTP bridge response too large");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const frame = this.#router.parseFrame(new TextDecoder().decode(bytes));
      if (!(frame instanceof BridgeResponse) || frame.reqId !== request.reqId || frame.ns !== request.ns || frame.method !== method) {
        throw new Error("HTTP bridge response mismatch");
      }
      if (!frame.ok) throw new Error(frame.error ? frame.error.message : "HTTP bridge request failed");
      return this.#router.rehydrateResult(frame);
    } finally {
      clearTimeout(timer);
      this.#pending.delete(controller);
    }
  }

  close() {
    this.#closed = true;
    for (const controller of this.#pending) controller.abort();
    this.#pending.clear();
  }
}
