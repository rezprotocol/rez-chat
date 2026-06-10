import { SchemaRecord } from "../SchemaRecord.js";
import { ConnectRequest } from "../domain/ConnectRequest.js";

export class ContactsListConnectRequestsResult extends SchemaRecord {
  static type = "chat.result.contacts_list_connect_requests";
  static schema = {
    items: { type: "array", record: ConnectRequest },
  };
}
