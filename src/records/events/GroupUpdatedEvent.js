import { SchemaRecord } from "../SchemaRecord.js";
import { ChatGroup } from "../domain/ChatGroup.js";

export class GroupUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.group_updated";
  static schema = {
    group: { type: "record", record: ChatGroup, required: true },
  };
}
