import {
  MeshStatusUpdatedEvent,
  MeshStatusParams,
  MeshStatusResult,
  NodeStatusParams,
  NodeStatusResult,
  PeerLinkGetParams,
  PeerLinkGetResult,
  PeerLinksListParams,
  PeerLinksListResult,
} from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerConnectionService extends BaseServerService {
  #offMeshStatusChanged;

  constructor({ bus, logger = console } = {}) {
    super({ bus, logger });
    this.#offMeshStatusChanged = null;
    this._register("peer-links", "list", (payload) => this.listPeerLinks(payload));
    this._register("peer-link", "get", (payload) => this.getPeerLink(payload));
    this._register("node", "status", (payload) => this.getNodeStatus(payload));
    this._register("mesh", "refresh", (payload) => this.refreshMesh(payload));
    this._register("mesh", "status", (payload) => this.getMeshStatus(payload));
  }

  async start() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (sdk && typeof sdk.onMeshStatusChanged === "function") {
      this.#offMeshStatusChanged = sdk.onMeshStatusChanged((status) => {
        this._emitMeshUpdated(status);
      });
    }
    this.getMeshStatus({}).then((current) => {
      if (current && current.mesh) {
        this._emitMeshUpdated(current.mesh);
      }
    }).catch((err) => {
      this.logger.error("[ServerConnectionService] initial mesh status failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerConnectionService", message: "initial mesh status failed", severity: "info", err });
    });
  }

  async stop() {
    if (typeof this.#offMeshStatusChanged === "function") {
      this.#offMeshStatusChanged();
      this.#offMeshStatusChanged = null;
    }
    await super.stop();
  }

  async listPeerLinks(payload = {}) {
    this._coerceParams(payload, PeerLinksListParams);
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    if (!peerLinks || !peerLinks.peerLinkStorage || !peerLinks.ownerAccountId) {
      return new PeerLinksListResult({ items: [] });
    }
    const items = await peerLinks.peerLinkStorage.peerLinks.listByOwner(peerLinks.ownerAccountId);
    return new PeerLinksListResult({ items: Array.isArray(items) ? items : [] });
  }

  async getPeerLink(payload = {}) {
    const params = this._coerceParams(payload, PeerLinkGetParams);
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    if (!peerLinks || !peerLinks.peerLinkStorage || !peerLinks.ownerAccountId) {
      return new PeerLinkGetResult({ peerLink: null });
    }
    const record = await peerLinks.peerLinkStorage.peerLinks.getById(peerLinks.ownerAccountId, params.peerLinkId);
    return new PeerLinkGetResult({ peerLink: record || null });
  }

  async getNodeStatus(payload = {}) {
    this._coerceParams(payload, NodeStatusParams);
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    const status = await sdk.node.status();
    return new NodeStatusResult({ status });
  }

  async getMeshStatus(payload = {}) {
    this._coerceParams(payload, MeshStatusParams);
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    const status = typeof sdk.node.meshStatus === "function"
      ? await sdk.node.meshStatus()
      : await sdk.node.status();
    return new MeshStatusResult({ mesh: meshFromStatus(status) });
  }

  async refreshMesh(payload = {}) {
    this._coerceParams(payload, MeshStatusParams);
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (sdk && typeof sdk.refreshMesh === "function") {
      const status = await sdk.refreshMesh();
      const mesh = meshFromStatus(status);
      this._emitMeshUpdated(mesh);
      return new MeshStatusResult({ mesh });
    }
    return this.getMeshStatus(payload);
  }

  _emitMeshUpdated(meshOrStatus) {
    const mesh = meshFromStatus(meshOrStatus);
    if (!mesh) return;
    this._emit("mesh.updated", new MeshStatusUpdatedEvent({ mesh }));
  }
}

// SDK's mesh-status response is sometimes `{ mesh: {...} }` and sometimes
// the inner mesh object directly. Unwrap to the inner object, then hand
// it to the MeshStatus record constructor (downstream) for validation.
function meshFromStatus(status) {
  if (!status || typeof status !== "object") return null;
  if (status.mesh && typeof status.mesh === "object") return status.mesh;
  return status;
}
