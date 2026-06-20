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
 * SSOT for "has this node lifted the single-device cap (E6 gate open)?" (Audit
 * R2 #6 — kills the gate split-brain P2 by negotiating one capability instead of
 * each side reading its own flag).
 *
 * When true, the node creates a NEW device cursor ONLY from a proven device.bind
 * — the legacy inbox.claim no-ops the cursor. So a client that merely connects
 * (claims) but never successfully binds would report "connected" yet have no
 * durable cursor, and later cursorAck/list would fail DEVICE_NOT_REGISTERED.
 * ServerRuntimeService therefore treats device.bind as a READINESS REQUIREMENT
 * (not a best-effort backfill) exactly when this returns true. Defaults false ⇒
 * gate-closed pg / fs / desktop nodes keep the legacy claim-creates-cursor path,
 * where a failed bind is harmless (the claim already made the cursor).
 *
 * @param {object} sdk
 * @returns {boolean}
 */
export function nodeRequiresProvenDevice(sdk) {
  if (!sdk || typeof sdk.getSessionInfo !== "function") return false;
  const info = sdk.getSessionInfo();
  if (!info || typeof info !== "object") return false;
  const caps = info.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return caps.multiDeviceFanout === true;
}
