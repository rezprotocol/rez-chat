import { SessionHelloResult } from "../records/results/SessionHelloResult.js";
import { CHAT_BRIDGE_SPEC } from "../server/transport/ChatBridge.js";
import { mapUnlockedAccountToRuntimeIdentity } from "../server/bootstrap/unlockedAccountIdentity.js";
import { activateDelegatedDevice } from "./activateDelegatedDevice.js";
import { prepareDelegatedCoreBoot } from "./prepareDelegatedCoreBoot.js";
import { startRezChatCore } from "./startRezChatCore.js";
import { MobileHostConfigV1, MobileHostEventV1 } from "./MobileHostRecords.js";

export class MobileRuntimeHost {
  #storage;
  #crypto;
  #config;
  #core = null;
  #starting = null;
  #deviceId = "";
  #off = [];
  #emit;
  #accountWsFactory;
  constructor(storage, crypto, config, emit, accountWsFactory = (url) => new WebSocket(url)) {
    if (!(config instanceof MobileHostConfigV1) || typeof emit !== "function") throw new Error("Mobile runtime requires typed configuration and event sink");
    this.#storage = storage; this.#crypto = crypto; this.#config = config; this.#emit = emit;
    this.#accountWsFactory = accountWsFactory;
  }
  async connect(account) {
    if (this.#starting) return this.#starting;
    if (this.#core) return this.#summary();
    this.#starting = this.#boot(account);
    try { return await this.#starting; } finally { this.#starting = null; }
  }
  async #boot(account) {
    const storageProvider = this.#storage.partition("mobile:account", account.accountId);
    const common = { storageProvider, cryptoProvider: this.#crypto, wsFactory: (url) => new WebSocket(url), uplinks: this.#config.portableUplinks, expectedNodePublicKeyB64: this.#config.portablePin };
    const mapped = mapUnlockedAccountToRuntimeIdentity(account);
    let options;
    if (mapped.hasAdminRoot) options = { ...common, identity: mapped.identity, deviceKey: mapped.deviceKey };
    else {
      await activateDelegatedDevice({ identity: { ...mapped.identity, bootstrapInboxId: account.bootstrapInboxId }, deviceKey: mapped.deviceKey, storageProvider, cryptoProvider: this.#crypto,
        accountHomeUplinks: this.#config.accountHomeUplinks, portableUplinks: this.#config.portableUplinks,
        expectedAccountHomeNodePublicKeyB64: this.#config.accountHomePin, expectedPortableNodePublicKeyB64: this.#config.portablePin, wsFactory: common.wsFactory, accountHomeWsFactory: this.#accountWsFactory });
      options = await prepareDelegatedCoreBoot({ ...common, unlocked: account });
    }
    const core = await startRezChatCore(options);
    try {
      for (const [name, EventRecord] of Object.entries(CHAT_BRIDGE_SPEC.events)) {
        this.#off.push(core.chatServer.bus.on(name, (payload) => {
          const record = payload instanceof EventRecord ? payload : new EventRecord(payload);
          this.#emit(new MobileHostEventV1(name, record));
        }));
      }
      await core.chatServer.start();
      this.#core = core;
      this.#deviceId = account.deviceId;
      return this.#summary();
    } catch (error) {
      for (const off of this.#off.splice(0)) off();
      await core.chatServer.stop();
      throw error;
    }
  }
  #summary() {
    return new SessionHelloResult({ accountId: this.#core.ownerAccountId, ownerAccountId: this.#core.ownerAccountId, deviceId: this.#deviceId, localInboxId: this.#core.inboxClaimant.inboxId });
  }
  async disconnect() {
    if (this.#starting) await this.#starting;
    if (!this.#core) return null;
    await this.#core.chatServer.stop();
    this.#core = null;
    this.#deviceId = "";
    for (const off of this.#off.splice(0)) off();
  }
  async call(method, raw) {
    if (!this.#core) throw new Error("Connect Rez Chat first");
    const spec = Object.hasOwn(CHAT_BRIDGE_SPEC.methods, method) ? CHAT_BRIDGE_SPEC.methods[method] : null;
    if (!spec) throw new Error("Unknown chat directive");
    // session.hello is a transport handshake. The native host already binds
    // the sole active vault identity; never let UI data rebind its principal.
    if (method === "session.hello") return this.#summary();
    return this.#core.bridge.handle(null, method, new spec.params(raw));
  }
  async lifecycle(name) {
    if (!this.#core) return null;
    const hooks = ["onForeground", "onBackground", "onPushWake", "onNetworkAvailable", "onPeriodicWake"];
    if (!hooks.includes(name)) throw new Error("Unknown lifecycle hook");
    return this.#core.adapter[name]();
  }
}
