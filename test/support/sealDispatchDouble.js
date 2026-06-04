import { MeshCapability, buildInboxAddress } from "@rezprotocol/sdk/client";

/**
 * Test double for the seal→dispatch send boundary that replaced
 * `sdk.sendEncryptedDeposit` (Phase 2c of the transport unification).
 *
 * Production now does two steps: `sdk.sealForPeer({...})` builds an opaque
 * object + an inbox(inboxId) address, then `sdk.mesh.dispatch(object, address)`
 * hands it to the mesh. This double wires both onto a fake sdk fragment, and
 * routes the dispatch through the REAL `MeshCapability` over a capturing
 * mailbox — so dispatch's address validation + inbox routing run for real;
 * only the crypto seal is faked (orchestration tests don't exercise crypto).
 *
 * Spread the result into a fake sdk:  `{ ...makeSealDispatch({...}), getIdentity }`.
 *
 * @param {object} [opts]
 * @param {(sealOpts:object)=>void} [opts.onSend]
 *   Called with the exact opts `sealForPeer` received (same shape
 *   `sendEncryptedDeposit` took: { peerAccountId, plaintextBodyBytes,
 *   deliverInboxId, receiptInboxId }). Push to a capture array here, or THROW
 *   to simulate a seal-time failure such as a NO_DELIVERY_TARGET (`err.code`).
 * @param {object|((body:object)=>object)} [opts.dispatchResult]
 *   The per-deposit result the node would return (e.g. `{ queued: true }`).
 *   A function receives the deposit body. Defaults to a synchronous "sent".
 * @returns {{ sealForPeer: Function, mesh: MeshCapability, dispatched: Array }}
 */
export function makeSealDispatch({ onSend = null, dispatchResult = null } = {}) {
  const dispatched = [];
  const mailbox = {
    deposit: async (body) => {
      dispatched.push(body);
      const r = typeof dispatchResult === "function" ? dispatchResult(body) : dispatchResult;
      return r && typeof r === "object"
        ? r
        : { mailboxId: body.mailboxId, eventId: "evt_" + dispatched.length, queued: false };
    },
  };
  const mesh = new MeshCapability({ pool: null, mailbox });
  const sealForPeer = async (sealOpts) => {
    if (typeof onSend === "function") await onSend(sealOpts);
    const o = sealOpts && typeof sealOpts === "object" ? sealOpts : {};
    const inboxId = String(o.deliverInboxId || ("inbox:" + (o.peerAccountId || "x")));
    const metadata = typeof o.receiptInboxId === "string" && o.receiptInboxId.trim().length > 0
      ? { receiptInboxId: o.receiptInboxId.trim() }
      : {};
    return {
      object: { payloadBytes: new Uint8Array([1, 2, 3]), metadata, capChain: null },
      address: buildInboxAddress({ inboxId }),
    };
  };
  return { sealForPeer, mesh, dispatched };
}
