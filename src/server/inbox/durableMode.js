/**
 * SSOT for "is this chat-server talking to a durable-capable node?" (S2).
 *
 * A durable node (Postgres-backed hosted cluster) advertises the `durableInbox`
 * capability in `session.ready` (SessionCapabilities), surfaced by the SDK via
 * getSessionInfo().capabilities. Against such a node the client uses the cursor
 * model — catch-up returns inline { seq, ciphertextB64 }, dedup keys on `seq`,
 * and consumed deposits advance the server-held device cursor via
 * `mailbox.cursorAck` instead of the destructive `mailbox.ack` (delete).
 *
 * Against a legacy / fs node (no capability) the client keeps the existing
 * list/fetch/ack delete model untouched. This is the D2 dual-mode gate — the one
 * check that protects the shipped desktop + DO-relay delivery path from any S2
 * behavior change. Both the catch-up drain and the live-push bridge consult this
 * single function so they can never disagree on mode.
 *
 * @param {object} sdk
 * @returns {boolean}
 */
export function nodeAdvertisesDurableInbox(sdk) {
  if (!sdk || typeof sdk.getSessionInfo !== "function") return false;
  const info = sdk.getSessionInfo();
  if (!info || typeof info !== "object") return false;
  const caps = info.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return caps.durableInbox === true;
}

/**
 * SSOT for the negotiated E6 multi-device fan-out gate: has this node lifted the
 * single-device cap and advertised `multiDeviceFanout` in `session.ready`?
 * (Audit R2 #6 — kills the gate split-brain by negotiating ONE capability
 * instead of each side reading its own flag.)
 *
 * Both downstream gates derive from this single capability read so they can
 * never disagree: ServerRuntimeService treats device.bind as a readiness
 * requirement (nodeRequiresProvenDevice), AND threads it onto
 * bus.runtime.multiDeviceFanout so ServerMessagesService's per-device sender
 * fan-out can actually engage (Audit R3 #3 — without this bridge the Slice-8
 * node-gate flip never reached the sender). Defaults false ⇒ gate-closed pg /
 * fs / desktop nodes keep the legacy single-device claim/sealForPeer path
 * byte-for-byte unchanged.
 *
 * @param {object} sdk
 * @returns {boolean}
 */
export function nodeEnablesMultiDeviceFanout(sdk) {
  if (!sdk || typeof sdk.getSessionInfo !== "function") return false;
  const info = sdk.getSessionInfo();
  if (!info || typeof info !== "object") return false;
  const caps = info.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return caps.multiDeviceFanout === true;
}

/**
 * The same negotiated E6 gate, read for its readiness meaning: when the node
 * enables multi-device fan-out it creates a NEW device cursor ONLY from a proven
 * device.bind (the legacy inbox.claim no-ops the cursor). So a client that
 * connects but never binds would report "connected" yet have no durable cursor,
 * and later cursorAck/list would fail DEVICE_NOT_REGISTERED. ServerRuntimeService
 * therefore treats device.bind as a READINESS REQUIREMENT exactly when this is
 * true. Delegates to nodeEnablesMultiDeviceFanout so the two gates share one
 * capability read (SSOT).
 *
 * @param {object} sdk
 * @returns {boolean}
 */
export function nodeRequiresProvenDevice(sdk) {
  return nodeEnablesMultiDeviceFanout(sdk);
}

/**
 * SSOT for "can this home carry a second device at all?" — the negotiated
 * `delegatedDevices` capability.
 *
 * DISTINCT from nodeEnablesMultiDeviceFanout, which negotiates cursor semantics
 * for a home that already has several devices. This one answers whether the
 * device-link ceremony can complete at all: it needs the node's account-mutation
 * serializer (to commit device.add) AND its authority revocation resolver
 * (delegated session admission fails closed without one). Both exist only on a
 * pg home, so an fs/desktop node advertises false.
 *
 * Read by the UI to decide whether to OFFER device linking. rez-chat#3: the
 * "Link a new device" button was unconditional, so on the default fs home a user
 * could start a ceremony that could never finish — it hung for 68 seconds and
 * then reported a bare timeout, which reads as a network fault rather than an
 * unsupported operation.
 *
 * Defaults false, so an older node that advertises no capability is treated as
 * unable to link. Wrongly hiding the button is recoverable; wrongly offering it
 * is the bug.
 *
 * @param {object} sdk
 * @returns {boolean}
 */
export function nodeSupportsDeviceLinking(sdk) {
  if (!sdk || typeof sdk.getSessionInfo !== "function") return false;
  const info = sdk.getSessionInfo();
  if (!info || typeof info !== "object") return false;
  const caps = info.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return caps.delegatedDevices === true;
}
