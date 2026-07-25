import { DeviceLinkApprover } from "@rezprotocol/sdk/device-link";
import { BaseServerService } from "../base/BaseServerService.js";
import { DeviceLinkStartParams } from "../../records/params/DeviceLinkStartParams.js";
import { DeviceLinkStatusParams } from "../../records/params/DeviceLinkStatusParams.js";
import { DeviceLinkApproveParams } from "../../records/params/DeviceLinkApproveParams.js";
import { DeviceLinkCancelParams } from "../../records/params/DeviceLinkCancelParams.js";
import { DeviceLinkStartResult } from "../../records/results/DeviceLinkStartResult.js";
import { DeviceLinkStatusResult } from "../../records/results/DeviceLinkStatusResult.js";
import { DeviceLinkApproveResult } from "../../records/results/DeviceLinkApproveResult.js";
import { DeviceLinkCancelResult } from "../../records/results/DeviceLinkCancelResult.js";
import { DeviceLinkUpdatedEvent } from "../../records/events/DeviceLinkUpdatedEvent.js";
import { PendingCeremonyStore } from "../storage/PendingCeremonyStore.js";

/**
 * ServerDeviceLinkService — the PRIMARY-device approver flow of the S10 PSK
 * device-link ceremony, exposed as bus directives:
 *
 *   deviceLink.start   → mint the single-use PSK, return { linkCode,
 *                        expiresAtMs }, and start the driver loop
 *   deviceLink.status  → current ceremony state (poll fallback)
 *   deviceLink.approve → the HUMAN gate: must echo the pending newDeviceId
 *                        (fingerprint cross-checked by the user in the UI)
 *   deviceLink.cancel  → veto / abort; drops the PSK
 *
 * Progress is emitted as `deviceLink.updated` events (CHAT_BRIDGE_SPEC.events
 * — transports stay generic). ONE ceremony at a time: the PSK is single-use
 * and the approver instance is coterminous with it.
 *
 * REGISTRATION-BEFORE-RELEASE (P1#2 / P1#2a). The approver is constructed with two required
 * seams this service supplies:
 *   registerDevice      → submits `device.add` carrying the new device's own inbox binding and the
 *                         minted leaf cert, and returns the HOME's committed row so the approver
 *                         can check the home bound this exact device/inbox/cert before any leaf is
 *                         released.
 *   registrationJournal → PendingCeremonyStore, so the exact sealed response is durable BEFORE
 *                         device.add and can be republished after a crash (a fresh ceremony would
 *                         mint a different certId and never converge).
 *
 * Key material: the account root B signs the leaf cert via
 * bus.runtime.accountAuthority (whose sign() THROWS on a delegated boot —
 * and start() refuses earlier with a typed error); B-dh ships in the bundle
 * from bus.runtime.accountIdentityDhKeyPair (threaded by bootstrapChatServer).
 */
export class ServerDeviceLinkService extends BaseServerService {
  #clock;
  #ceremony; // null | { approver, state, expiresAtMs, pending, resolveApproval, rejectApproval, driver }
  #pendingCeremonies;

  constructor({ bus, ownerAccountId, storageProvider = null, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#ceremony = null;
    // The durable persist-and-resume journal (P1#2a). Required to run a ceremony at all — a
    // registration with nothing to resume from cannot be recovered, only abandoned — but the
    // service still constructs without it so non-linking boots are unaffected; startCeremony is
    // where the requirement bites.
    this.#pendingCeremonies = storageProvider
      ? new PendingCeremonyStore({ storageProvider, clock: this.#clock })
      : null;
    this._register("deviceLink", "start", (payload) => this.startCeremony(payload || {}));
    this._register("deviceLink", "status", (payload) => this.statusCeremony(payload || {}));
    this._register("deviceLink", "approve", (payload) => this.approveCeremony(payload || {}));
    this._register("deviceLink", "cancel", (payload) => this.cancelCeremony(payload || {}));
  }

  #sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  #emitUpdated(fields) {
    this._emit("deviceLink.updated", new DeviceLinkUpdatedEvent(fields));
  }

  async startCeremony(payload) {
    this._coerceParams(payload, DeviceLinkStartParams);
    const sdk = this.#sdk();
    if (!sdk || !sdk.durableRecords) {
      throw new Error("deviceLink.start requires bus.runtime.sdk (connected chat server)");
    }
    const peerLinks = this.bus.runtime ? this.bus.runtime.peerLinks : null;
    if (peerLinks && peerLinks.hasAdminRoot === false) {
      const err = new Error("deviceLink.start: this device is delegated — only the primary device can link a new device");
      err.code = "DELEGATED_DEVICE";
      throw err;
    }
    const authority = this.bus.runtime ? this.bus.runtime.accountAuthority : null;
    if (!authority || !authority.signer || typeof authority.signer.sign !== "function"
      || typeof authority.signer.getSignerRef !== "function") {
      throw new Error("deviceLink.start requires bus.runtime.accountAuthority (the account signing root)");
    }
    const accountDhKeyPair = this.bus.runtime ? this.bus.runtime.accountIdentityDhKeyPair : null;
    if (!accountDhKeyPair || !accountDhKeyPair.publicKeyB64 || !accountDhKeyPair.privateKeyB64) {
      throw new Error("deviceLink.start: account identity-DH key unavailable (pre-migration vault) — re-create the account before linking devices");
    }
    if (this.#ceremony && this.#ceremony.state !== "done" && this.#ceremony.state !== "failed"
      && this.#ceremony.state !== "expired" && this.#ceremony.state !== "cancelled") {
      const err = new Error("deviceLink.start: a link ceremony is already in progress — cancel it first");
      err.code = "LINK_IN_PROGRESS";
      throw err;
    }

    const signerRef = authority.signer.getSignerRef();
    const cryptoProvider = peerLinks && peerLinks.cryptoProvider ? peerLinks.cryptoProvider : null;
    if (!cryptoProvider) {
      throw new Error("deviceLink.start requires a cryptoProvider (via bus.runtime.peerLinks)");
    }
    if (!this.#pendingCeremonies) {
      throw new Error(
        "deviceLink.start requires a storageProvider for the pending-ceremony journal (P1#2a):"
          + " a registration that is not durable before device.add cannot be resumed after a crash",
      );
    }
    const approver = new DeviceLinkApprover({
      crypto: cryptoProvider,
      records: sdk.durableRecords,
      accountSignPublicKeyB64: signerRef.signerPublicKeyB64,
      accountSign: (bytes) => authority.signer.sign(bytes),
      accountDhKeyPair,
      // P1#2 registration-before-release + P1#2a persist-and-resume.
      registerDevice: (args) => this.#registerDevice(args),
      registrationJournal: {
        persistPending: (record) => this.#pendingCeremonies.createPending(record),
        markPublished: ({ deviceId }) => this.#pendingCeremonies.markPublished(deviceId),
        markConfirmed: ({ deviceId }) => this.#pendingCeremonies.markConfirmed(deviceId),
        warn: (message) => this.logger.warn(message),
      },
      nowMs: this.#clock,
    });
    const started = await approver.start();
    const ceremony = {
      approver,
      state: "code-issued",
      expiresAtMs: started.expiresAtMs,
      pending: null,
      resolveApproval: null,
      rejectApproval: null,
      driver: null,
    };
    this.#ceremony = ceremony;
    this.#emitUpdated({ state: "code-issued", expiresAtMs: started.expiresAtMs });
    // Unawaited driver loop — every await inside is error-trapped and every
    // exit path emits a terminal event, so nothing is silently dropped.
    ceremony.driver = this.#drive(ceremony).catch((err) => {
      this.logger.error("ServerDeviceLinkService driver failed unexpectedly", {
        message: err && err.message ? err.message : String(err),
      });
    });
    return new DeviceLinkStartResult({ linkCode: started.code, expiresAtMs: started.expiresAtMs });
  }

  async #drive(ceremony) {
    // Phase 1: wait for the new device's request.
    let pending;
    try {
      pending = await ceremony.approver.waitForRequest();
    } catch (err) {
      const cancelled = err && err.code === "DEVICE_LINK_CANCELLED";
      ceremony.state = cancelled ? "cancelled" : "expired";
      this.#emitUpdated({
        state: ceremony.state,
        message: err && err.message ? err.message : String(err),
      });
      return;
    }
    ceremony.pending = { newDeviceId: pending.newDeviceId, fingerprint: pending.fingerprint };
    ceremony.state = "pending";
    this.#emitUpdated({
      state: "pending",
      newDeviceId: pending.newDeviceId,
      fingerprint: pending.fingerprint,
      expiresAtMs: ceremony.expiresAtMs,
    });

    // Phase 2: park on the human approval (deviceLink.approve resolves it,
    // deviceLink.cancel rejects it).
    try {
      await new Promise((resolve, reject) => {
        ceremony.resolveApproval = resolve;
        ceremony.rejectApproval = reject;
      });
    } catch (err) {
      ceremony.approver.cancel();
      ceremony.state = "cancelled";
      this.#emitUpdated({ state: "cancelled", newDeviceId: ceremony.pending.newDeviceId });
      return;
    }

    // Phase 3: respond + wait for the key confirmation.
    ceremony.state = "responding";
    this.#emitUpdated({ state: "responding", newDeviceId: ceremony.pending.newDeviceId });
    try {
      const done = await ceremony.approver.approve();
      ceremony.state = "confirmed";
      this.#emitUpdated({ state: "confirmed", newDeviceId: done.newDeviceId });
    } catch (err) {
      ceremony.state = "failed";
      this.#emitUpdated({
        state: "failed",
        newDeviceId: ceremony.pending.newDeviceId,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Submit `device.add` for the device being linked, and return the HOME's committed row.
   *
   * The approver validates the returned commit against the leaf it minted, so what is returned
   * here must be what the HOME stored — not an echo of the arguments. Echoing the inputs would
   * make that check tautological; reading back the committed registry row makes it catch a home
   * that bound something different.
   *
   * COMMIT != PROPAGATION: `account-mutation`/`submit` reports propagation outcomes on its result
   * rather than throwing (see ServerAccountMutationService), so a peer-republish failure cannot
   * withhold a leaf whose registration already committed. A propagation failure is logged here and
   * left to the durable outbox + the next drain.
   */
  async #registerDevice({ newDeviceId, deviceInboxBinding, deviceCapability } = {}) {
    const deviceId = typeof newDeviceId === "string" ? newDeviceId.trim() : "";
    if (deviceId.length === 0) {
      throw new Error("deviceLink registerDevice: newDeviceId is required");
    }
    if (!deviceInboxBinding || typeof deviceInboxBinding !== "object") {
      throw new Error("deviceLink registerDevice: deviceInboxBinding is required");
    }
    if (!deviceCapability || typeof deviceCapability !== "object") {
      throw new Error("deviceLink registerDevice: deviceCapability (the leaf cert) is required");
    }

    const result = await this._call("account-mutation", "submit", {
      action: "device.add",
      target: { deviceInboxBinding, deviceCapability },
      signWith: "account",
    });
    if (!result || typeof result !== "object") {
      throw new Error("deviceLink registerDevice: the account-mutation service returned no result");
    }
    const devices = Array.isArray(result.devices) ? result.devices : null;
    if (devices === null) {
      throw new Error("deviceLink registerDevice: the commit carried no device set to confirm against");
    }
    const committed = devices.find((d) => d && typeof d.deviceId === "string" && d.deviceId === deviceId);
    if (!committed) {
      throw new Error("deviceLink registerDevice: the home committed a mutation that does not contain device " + deviceId);
    }
    const propagation = result.propagation && typeof result.propagation === "object" ? result.propagation : null;
    if (propagation && Array.isArray(propagation.peersFailed) && propagation.peersFailed.length > 0) {
      // Reported, NOT fatal: the registration is committed and the authority-state publication is
      // durable. Failing here would withhold a leaf for a device the home already registered.
      this.logger.warn(
        "[ServerDeviceLinkService] device.add committed for " + deviceId + " but "
          + propagation.peersFailed.length + " peer device-set republish(es) failed; the"
          + " registration stands and propagation is retried separately",
      );
    }
    return { deviceId: committed.deviceId, inboxId: committed.inboxId, certId: committed.certId };
  }

  async statusCeremony(payload) {
    this._coerceParams(payload, DeviceLinkStatusParams);
    const ceremony = this.#ceremony;
    if (!ceremony) {
      return new DeviceLinkStatusResult({ state: "idle" });
    }
    return new DeviceLinkStatusResult({
      state: ceremony.state,
      newDeviceId: ceremony.pending ? ceremony.pending.newDeviceId : null,
      fingerprint: ceremony.pending ? ceremony.pending.fingerprint : null,
      expiresAtMs: ceremony.expiresAtMs,
    });
  }

  async approveCeremony(payload) {
    const params = this._coerceParams(payload, DeviceLinkApproveParams);
    const ceremony = this.#ceremony;
    if (!ceremony || ceremony.state !== "pending" || !ceremony.pending || !ceremony.resolveApproval) {
      const err = new Error("deviceLink.approve: no pending link request");
      err.code = "NO_PENDING_REQUEST";
      throw err;
    }
    if (params.newDeviceId !== ceremony.pending.newDeviceId) {
      const err = new Error("deviceLink.approve: newDeviceId does not match the pending request");
      err.code = "DEVICE_ID_MISMATCH";
      throw err;
    }
    const resolveApproval = ceremony.resolveApproval;
    ceremony.resolveApproval = null;
    ceremony.rejectApproval = null;
    resolveApproval();
    // The driver publishes the response and waits for the confirmation; the
    // caller watches deviceLink.updated (or polls status) for the terminal
    // state — approve() returning means the approval was ACCEPTED, not that
    // the ceremony finished.
    return new DeviceLinkApproveResult({ state: "responding", newDeviceId: params.newDeviceId });
  }

  async cancelCeremony(payload) {
    this._coerceParams(payload, DeviceLinkCancelParams);
    const ceremony = this.#ceremony;
    if (!ceremony) {
      return new DeviceLinkCancelResult({ state: "idle" });
    }
    if (ceremony.rejectApproval) {
      // Parked on the human gate: reject the approval promise — the driver
      // cancels the approver and emits the terminal event.
      const rejectApproval = ceremony.rejectApproval;
      ceremony.resolveApproval = null;
      ceremony.rejectApproval = null;
      rejectApproval(new Error("device link vetoed"));
    } else {
      ceremony.approver.cancel();
      if (ceremony.state !== "done" && ceremony.state !== "confirmed"
        && ceremony.state !== "failed" && ceremony.state !== "expired") {
        ceremony.state = "cancelled";
        this.#emitUpdated({ state: "cancelled" });
      }
    }
    return new DeviceLinkCancelResult({ state: "cancelled" });
  }

  async stop() {
    if (this.#ceremony) {
      await this.cancelCeremony({});
      if (this.#ceremony.driver) {
        await this.#ceremony.driver;
      }
      this.#ceremony = null;
    }
    await super.stop();
  }
}
