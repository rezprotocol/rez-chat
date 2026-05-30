import { SchemaRecord } from "../SchemaRecord.js";

/**
 * channels.syncAll params. Takes nothing — the server walks the caller's
 * groups and dispatches `channels.sync_request` ops to every active peer in
 * each. Triggered from the renderer on session-runtime-connect so a
 * just-logged-in client catches up on channels (and group titles) created
 * while it was offline.
 */
export class ChannelsSyncAllParams extends SchemaRecord {
  static type = "chat.params.channels_syncall";
  static schema = {};
}
