import { RRecord } from "@rezprotocol/sdk/client";
import { ChatThread } from "../domain/ChatThread.js";
import { ThreadMessagesListResult } from "./ThreadMessagesListResult.js";

export class ThreadGetResult extends RRecord {
  static type = "chat.result.thread_get";

  constructor(raw = {}) {
    super();
    this.thread = raw.thread instanceof ChatThread ? raw.thread : new ChatThread(raw.thread || {});
    const rawMsgs = raw.messages && typeof raw.messages === "object" ? raw.messages : {};
    this.messages = new ThreadMessagesListResult({
      items: Array.isArray(rawMsgs.messages) ? rawMsgs.messages : [],
      nextBefore: rawMsgs.nextBefore && typeof rawMsgs.nextBefore === "object" ? rawMsgs.nextBefore : rawMsgs.cursor,
    });
    this._seal();
  }

  validate() {
    this.assert(this.thread !== null, "ThreadGetResult requires thread");
    this.assert(this.messages !== null, "ThreadGetResult requires messages");
  }
}
