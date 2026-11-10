import { BaseBusService } from "./BaseBusService.js";

function hasReachableSeed(seedReachable) {
  if (!seedReachable || typeof seedReachable !== "object") return false;
  return Object.values(seedReachable).some((value) => value === true);
}

function isMeshReady(mesh) {
  if (!mesh || typeof mesh !== "object") return false;
  return Number(mesh.peerCount || 0) > 0 || hasReachableSeed(mesh.seedReachable);
}

export class ConnectionService extends BaseBusService {
  constructor({ bus, connectionStore } = {}) {
    super({ bus });
    if (!connectionStore) throw new Error("ConnectionService requires connectionStore");
    this._connectionStore = connectionStore;
    this._register("mesh", "refresh", () => this.refresh());
    this._register("mesh", "status", () => this.getStatus());
    this._register("mesh", "getStatus", () => this.getStatus());
    this._listen("runtime.connecting", (record) => {
      const next = record && typeof record === "object" ? record : { status: "connecting" };
      this._connectionStore.setConnection({ ...next, inboxSynced: false });
    });
    this._listen("runtime.mesh.updated", (record) => {
      const mesh = record && record.mesh && typeof record.mesh === "object" ? record.mesh : null;
      const current = this._connectionStore.getConnection();
      const currentStatus = current && current.status ? String(current.status) : "disconnected";
      const nextStatus = currentStatus === "connected"
        ? "connected"
        : isMeshReady(mesh)
          ? "connected"
          : "connecting";
      this._connectionStore.setConnection({
        status: mesh ? nextStatus : "connecting",
        mesh,
        lastError: null,
      });
    });
    this._listen("runtime.connected", () => {
      // Catch-up can finish before connect() returns. Its completion must
      // survive this notification; connecting/disconnected reset the gate.
      this._connectionStore.setConnection({ status: "connected" });
    });
    this._listen("runtime.disconnected", () => {
      this._connectionStore.setConnection({ status: "disconnected", inboxSynced: false });
    });
    this._listen("runtime.event.connection.state", (record) => {
      const status = record && record.status ? String(record.status).trim() : "";
      if (!status) return;
      const patch = {
        status,
        activeNode: record && record.activeUplink ? String(record.activeUplink) : "",
        lastError: record && record.reason ? String(record.reason) : null,
      };
      if (status !== "connected") patch.inboxSynced = false;
      this._connectionStore.setConnection(patch);
    });
    // Inbox catch-up finished draining + applying every missed deposit. Now the
    // displayed state (rosters, messages) is authoritative — let views stop
    // showing "syncing" and assert real state.
    this._listen("runtime.event.inbox.caughtup", () => {
      this._connectionStore.setConnection({ inboxSynced: true });
    });
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  async refresh() {
    const client = this._getClient();
    if (!client || typeof client.call !== "function") {
      return this._connectionStore.getConnection();
    }
    const result = await client.call("mesh.refresh", {}).catch(() => null);
    const mesh = result && result.mesh ? result.mesh : null;
    this._connectionStore.setConnection({
      status: "connected",
      activeNode: typeof client.getActiveUplink === "function" ? client.getActiveUplink() : "",
      nodes: typeof client.getUplinkStates === "function" ? client.getUplinkStates() : [],
      mesh,
    });
    return this._connectionStore.getConnection();
  }

  getStatus() {
    return this._connectionStore.getConnection();
  }
}
