import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/**
 * MeshStatus: snapshot of the local node's mesh connectivity. Produced by
 * the rez-node mesh service, surfaced through ServerConnectionService, and
 * delivered to the UI via mesh.updated events. Internal counters/maps are
 * passed through as-is — they're opaque blobs from the substrate.
 */
export class MeshStatus extends RRecord {
  static type = "chat.meshStatus";

  constructor(raw = {}) {
    super();
    this.enabled = raw.enabled === true;
    this.mode = nonEmptyString(raw.mode);
    this.participateInRouting = raw.participateInRouting === true;
    this.peerCount = Math.max(0, Math.trunc(toFiniteNumber(raw.peerCount, 0)));
    this.lastDiscoveryAtMs = raw.lastDiscoveryAtMs == null
      ? null
      : toFiniteNumber(raw.lastDiscoveryAtMs, 0);
    this.seedReachable = raw.seedReachable && typeof raw.seedReachable === "object"
      ? raw.seedReachable
      : {};
    this.routeStats = raw.routeStats && typeof raw.routeStats === "object"
      ? raw.routeStats
      : {};
    this.policy = raw.policy && typeof raw.policy === "object"
      ? raw.policy
      : {};
    this.peers = Array.isArray(raw.peers) ? raw.peers : [];
    this._seal();
  }

  validate() {}
}
