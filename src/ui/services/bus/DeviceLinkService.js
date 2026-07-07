import { BaseBusService } from "./BaseBusService.js";

/**
 * DeviceLinkService (S2.5 S10, primary-side UI) — the thin bus forwarder for
 * the device-link approver directives. Views call these instead of touching
 * bus.runtime.client; the runtime `deviceLink.updated` event is re-emitted as
 * a plain bus event the modal subscribes to.
 */
export class DeviceLinkService extends BaseBusService {
  constructor({ bus } = {}) {
    super({ bus });
    this._register("deviceLink", "start", () => this.start());
    this._register("deviceLink", "status", () => this.status());
    this._register("deviceLink", "approve", (payload) => this.approve(payload || {}));
    this._register("deviceLink", "cancel", () => this.cancel());
    this._listen("runtime.event.deviceLink.updated", (record) => {
      this.bus.emit("deviceLink.updated", record);
    });
  }

  _client() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  #requireClient() {
    const client = this._client();
    if (!client) {
      throw new Error("Device linking requires a connected session");
    }
    return client;
  }

  async start() {
    return this.#requireClient().call("deviceLink.start", {});
  }

  async status() {
    return this.#requireClient().call("deviceLink.status", {});
  }

  async approve({ newDeviceId = "" } = {}) {
    return this.#requireClient().call("deviceLink.approve", { newDeviceId });
  }

  async cancel() {
    return this.#requireClient().call("deviceLink.cancel", {});
  }
}
