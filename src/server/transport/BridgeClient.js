import crypto from "node:crypto";

export class BridgeClient {
  #id;
  #ws;
  #authenticated;
  #accountId;
  #deviceId;
  #createdAtMs;

  constructor({ id, ws }) {
    if (!ws || typeof ws !== "object") {
      throw new Error("BridgeClient requires ws");
    }
    this.#id = typeof id === "string" && id.length > 0 ? id : crypto.randomBytes(16).toString("hex");
    this.#ws = ws;
    this.#authenticated = false;
    this.#accountId = null;
    this.#deviceId = null;
    this.#createdAtMs = Date.now();
  }

  get id() {
    return this.#id;
  }

  get ws() {
    return this.#ws;
  }

  get authenticated() {
    return this.#authenticated;
  }

  get accountId() {
    return this.#accountId;
  }

  get deviceId() {
    return this.#deviceId;
  }

  get createdAtMs() {
    return this.#createdAtMs;
  }

  authenticate({ accountId, deviceId }) {
    if (typeof accountId !== "string" || accountId.trim().length === 0) {
      throw new Error("BridgeClient.authenticate requires non-empty accountId");
    }
    if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
      throw new Error("BridgeClient.authenticate requires non-empty deviceId");
    }
    this.#authenticated = true;
    this.#accountId = accountId.trim();
    this.#deviceId = deviceId.trim();
  }

  sendFrame(frameRecord) {
    if (!frameRecord || typeof frameRecord !== "object") {
      throw new Error("BridgeClient.sendFrame requires a frame record");
    }
    if (typeof frameRecord.toJSON !== "function") {
      throw new Error("BridgeClient.sendFrame requires a record with toJSON()");
    }
    const json = frameRecord.toJSON();
    json.type = frameRecord.type;
    this.#ws.send(JSON.stringify(json));
  }

  close(code, reason) {
    if (this.#ws && typeof this.#ws.close === "function") {
      this.#ws.close(code, reason);
    }
  }
}
