import { groupOpPayloadToBytes } from "../../records/payloads/GroupOpPayloadV1.js";

/**
 * ServerGroupBroadcaster: seals a GroupOpPayloadV1 to each target peer and
 * dispatches it over the mesh. The single fan-out primitive for group ops
 * (leave/rename/kick/setRole/member.join forward/group.state). Per-target
 * failures are logged, never thrown (Promise.allSettled) — one unreachable
 * member must not abort fan-out to the rest.
 *
 * Extracted from ServerGroupsService (FLOW_AUDIT 2026-06-07 finding #8) as the
 * cohesive "broadcast" collaborator; behavior is unchanged.
 */
export class ServerGroupBroadcaster {
  #bus;
  #logger;

  constructor({ bus, logger = console } = {}) {
    if (!bus) throw new Error("ServerGroupBroadcaster requires bus");
    this.#bus = bus;
    this.#logger = logger || console;
  }

  async fanOut({ targets, payload } = {}) {
    if (!Array.isArray(targets) || targets.length === 0) return;
    const sdk = this.#bus.runtime ? this.#bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) {
      this.#logger.warn("[ServerGroupBroadcaster] sdk unavailable, skipping group-op fan-out");
      return;
    }
    const bodyBytes = groupOpPayloadToBytes(payload);
    await Promise.allSettled(targets.map((accountId) =>
      sdk.sealForPeer({
        peerAccountId: accountId,
        plaintextBodyBytes: bodyBytes,
      }).then((sealed) => sdk.mesh.dispatch(
        sealed.object,
        sealed.address,
      )).catch((err) => {
        this.#logger.warn(
          "[ServerGroupBroadcaster] group-op fan-out to " + accountId + " failed",
          err && err.message ? err.message : err,
        );
      })
    ));
  }
}
