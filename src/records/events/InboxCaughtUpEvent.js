import { SchemaRecord } from "../SchemaRecord.js";

/**
 * Emitted by InboxCatchupService once the inbox is fully drained AND every
 * missed deposit has been applied (the drain awaits each through the serialized
 * InboundDepositPipeline). The UI gates "show real state" on this so login does
 * not assert the stale pre-catch-up snapshot (empty roster / missing messages).
 */
export class InboxCaughtUpEvent extends SchemaRecord {
  static type = "chat.evt.inbox_caughtup";
  static schema = {
    mailboxId: { type: "string", trim: true },
  };
}
