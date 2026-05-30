import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

export const PENDING_MUTATION_KINDS = Object.freeze({
  EDIT: "edit",
  TOMBSTONE: "tombstone",
  REACTION_ADD: "reaction.add",
  REACTION_REMOVE: "reaction.remove",
});

const VALID_KINDS = new Set(Object.values(PENDING_MUTATION_KINDS));

/**
 * PendingMutation: a single buffered out-of-order mutation (edit / tombstone
 * / reaction) keyed by `targetMessageId` until the target arrives. The kind
 * discriminator selects which trailing fields are meaningful; unused
 * kind-specific fields default to their zero values and are ignored at apply
 * time.
 */
export class PendingMutation extends RRecord {
  static type = "chat.pendingMutation";

  constructor(raw = {}) {
    super();
    this.kind = nonEmptyString(raw.kind);
    this.threadId = nonEmptyString(raw.threadId);
    this.targetMessageId = nonEmptyString(raw.targetMessageId);
    this.senderAccountId = nonEmptyString(raw.senderAccountId);
    this.receivedAtMs = Math.trunc(toFiniteNumber(raw.receivedAtMs, 0));
    this.newText = typeof raw.newText === "string" ? raw.newText : "";
    this.editedAtMs = Math.trunc(toFiniteNumber(raw.editedAtMs, 0));
    this.tombstonedAtMs = Math.trunc(toFiniteNumber(raw.tombstonedAtMs, 0));
    this.emoji = nonEmptyString(raw.emoji);
    this._seal();
  }

  validate() {
    this.assert(VALID_KINDS.has(this.kind), `PendingMutation.kind must be one of ${[...VALID_KINDS].join("|")}, got '${this.kind}'`);
    this.assert(this.threadId.length > 0, "PendingMutation: threadId required");
    this.assert(this.targetMessageId.length > 0, "PendingMutation: targetMessageId required");
    this.assert(this.senderAccountId.length > 0, "PendingMutation: senderAccountId required");
    this.assert(this.receivedAtMs > 0, "PendingMutation: receivedAtMs > 0 required");
    if (this.kind === PENDING_MUTATION_KINDS.EDIT) {
      this.assert(this.editedAtMs > 0, "PendingMutation(edit): editedAtMs > 0 required");
    } else if (this.kind === PENDING_MUTATION_KINDS.TOMBSTONE) {
      this.assert(this.tombstonedAtMs > 0, "PendingMutation(tombstone): tombstonedAtMs > 0 required");
    } else {
      this.assert(this.emoji.length > 0, "PendingMutation(reaction): emoji required");
    }
  }
}
