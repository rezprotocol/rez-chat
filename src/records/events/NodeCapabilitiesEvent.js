import { SchemaRecord } from "../SchemaRecord.js";

/**
 * What the HOME NODE can do for this session, emitted by ServerRuntimeService
 * once a session is bound and the node has advertised its SessionCapabilities.
 *
 * These are node capabilities, distinct from the machine capabilities
 * (keychain, biometric) SessionStore already holds under
 * environmentCapabilities. The same account can have different answers here on
 * two different machines, because it depends on the home it connected to.
 *
 * Exists so the UI can decline to OFFER an operation the home cannot perform,
 * rather than letting a user start one that fails later (rez-chat#3: "Link a
 * new device" was unconditional, and an fs/desktop home answered with a
 * 68-second timeout).
 *
 * Every field defaults false. An older server that never emits this leaves the
 * UI in the "unsupported" state — wrongly hiding an affordance is recoverable,
 * wrongly offering it is the bug this closes.
 */
export class NodeCapabilitiesEvent extends SchemaRecord {
  static type = "chat.evt.node_capabilities";
  static schema = {
    // Can this home carry a second device? Requires a pg home: an fs/desktop
    // node has no account-mutation serializer to commit device.add and no
    // authority resolver, so delegated session admission fails closed.
    deviceLinking: { type: "boolean" },
  };
}
