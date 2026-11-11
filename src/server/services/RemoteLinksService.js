import { BaseServerService } from "../base/BaseServerService.js";
import { LinksUnfurlParams } from "../../records/params/LinksUnfurlParams.js";
import { HttpBridgeClient } from "../../client/transport/HttpBridgeClient.js";
import { CHAT_BRIDGE_SPEC } from "../transport/ChatBridge.js";

export class RemoteLinksService extends BaseServerService {
  #client;

  constructor({ bus, endpoint, ownerAccountId, logger } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#client = new HttpBridgeClient({ endpoint, spec: CHAT_BRIDGE_SPEC });
    this._register("links", "unfurl", (payload) => this.#client.call("links.unfurl", this._coerceParams(payload, LinksUnfurlParams)));
  }

  async stop() {
    this.#client.close();
    await super.stop();
  }
}
