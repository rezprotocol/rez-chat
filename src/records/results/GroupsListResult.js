import { SchemaRecord } from "../SchemaRecord.js";
import { ChatGroup } from "../domain/ChatGroup.js";

export class GroupsListResult extends SchemaRecord {
  static type = "chat.result.groups_list";
  static schema = {
    items: { type: "array", record: ChatGroup },
  };
}
