import { SchemaRecord } from "../SchemaRecord.js";

export class LinksUnfurlParams extends SchemaRecord {
  static type = "chat.params.links_unfurl";
  static schema = {
    url: { type: "string", required: true, trim: true, maxLength: 2048 },
    forceRefresh: { type: "boolean" },
  };
}
