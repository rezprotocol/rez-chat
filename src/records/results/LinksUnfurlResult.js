import { SchemaRecord } from "../SchemaRecord.js";
import { LinkPreview } from "../domain/LinkPreview.js";

export class LinksUnfurlResult extends SchemaRecord {
  static type = "chat.result.links_unfurl";
  static schema = {
    preview: { type: "record", record: LinkPreview, required: true },
    cached: { type: "boolean" },
  };
}
