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
