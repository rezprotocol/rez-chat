import { ThreadStoreService, ThreadIndexService, ContactStore, GroupStore, ChannelStore, LinkPreviewStore } from "../storage/index.js";
import { ChatServerBus } from "./ChatServerBus.js";
import { ChatBridge } from "../transport/ChatBridge.js";
import { InboundDepositPipeline } from "../runtime/InboundDepositPipeline.js";
import { ProcessedDepositLog } from "../inbox/ProcessedDepositLog.js";
import {
  ServerRuntimeService,
  ServerSessionService,
  ServerThreadsService,
  ServerMessagesService,
  ServerContactsService,
  ServerGroupsService,
  ServerChannelsService,
  ServerInvitesService,
  ServerConnectionService,
  ServerEventService,
  ServerPeerLinkProtocolService,
  ServerFileTransferService,
  ServerProfileService,
  ServerLinksService,
  InboxCatchupService,
  GlobalGroupLookup,
} from "../services/index.js";

export class ChatServerApp {
  #started;
  #services;
  #clock;
  #ownerAccountId;
  #storageProvider;
  #bridge;

  constructor({
    identity,
    uplinks,
    storageProvider,
    ownerAccountId,
    clock = () => Date.now(),
    sdk = null,
    peerLinkService = null,
    inboxClaimant = null,
    expectedNodePublicKeyB64 = "",
    logger = console,
  } = {}) {
    if (!Array.isArray(uplinks) || uplinks.length === 0) {
      throw new Error("ChatServerApp requires uplinks");
    }
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ChatServerApp requires storageProvider");
    }
    if (typeof ownerAccountId !== "string" || ownerAccountId.trim().length === 0) {
      throw new Error("ChatServerApp requires ownerAccountId");
    }
    this.#started = false;
    this.#clock = clock;
    this.#ownerAccountId = ownerAccountId.trim();
    this.#storageProvider = storageProvider;
    this.bus = new ChatServerBus({
      config: { identity, uplinks, ownerAccountId: this.#ownerAccountId },
      logger,
    });
    this.#createStores(storageProvider);
    // Expose chat-server's persistent inbox claim to handlers via the bus
    // runtime — chat-server uses this inboxId for invites/deposits instead
    // of the SDK session's ephemeral assignment.
    this.bus.runtime.inboxClaimant = inboxClaimant;
    this.#createServices({ identity, uplinks, clock, sdk, peerLinkService, inboxClaimant, expectedNodePublicKeyB64, logger });
    this.#bridge = new ChatBridge({
      bus: this.bus,
      ownerAccountId: this.#ownerAccountId,
      logger,
    });
    this.bus.transport.bridge = this.#bridge;
  }

  get bridge() {
    return this.#bridge;
  }

  get started() {
    return this.#started;
  }

  get ownerAccountId() {
    return this.#ownerAccountId;
  }

  get storageProvider() {
    return this.#storageProvider;
  }

  get sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  get threadStore() {
    return this.bus.stores.threadStore;
  }

  get threadIndex() {
    return this.bus.stores.threadIndex;
  }

  get contactStore() {
    return this.bus.stores.contactStore;
  }

  get groupStore() {
    return this.bus.stores.groupStore;
  }

  on(eventName, handler) {
    return this.bus.on(eventName, handler);
  }

  off(eventName, handler) {
    this.bus.off(eventName, handler);
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    this.bus.emit("server.starting", {});
    await this.bus.services.runtime.connect();
    for (const service of this.#services) {
      if (service === this.bus.services.runtime) continue;
      if (service && typeof service.start === "function") {
        await service.start();
      }
    }
    this.bus.resolveReady.server();
    this.bus.emit("server.ready", {});
  }

  async stop() {
    if (!this.#started) return;
    this.bus.emit("server.stopping", {});
    const list = [...this.#services].reverse();
    for (const service of list) {
      if (service && typeof service.stop === "function") {
        await service.stop();
      }
    }
    this.#started = false;
  }

  #createStores(storageProvider) {
    this.bus.stores.storageProvider = storageProvider;
    this.bus.stores.threadStore = new ThreadStoreService({
      storageProvider,
      ownerAccountId: this.#ownerAccountId,
      clock: this.#clock,
    });
    this.bus.stores.threadIndex = new ThreadIndexService({
      storageProvider,
      ownerAccountId: this.#ownerAccountId,
      threadStore: this.bus.stores.threadStore,
      clock: this.#clock,
    });
    this.bus.stores.contactStore = new ContactStore({
      storageProvider,
      clock: this.#clock,
    });
    this.bus.stores.groupStore = new GroupStore({
      storageProvider,
      clock: this.#clock,
    });
    this.bus.stores.channelStore = new ChannelStore({
      storageProvider,
      clock: this.#clock,
    });
    this.bus.stores.linkPreviewStore = new LinkPreviewStore({
      storageProvider,
      clock: this.#clock,
    });
    this.bus.stores.globalGroupLookup = new GlobalGroupLookup({
      groupStore: this.bus.stores.groupStore,
    });
  }

  #createServices({ identity, uplinks, clock, sdk, peerLinkService, inboxClaimant, expectedNodePublicKeyB64, logger }) {
    const services = {
      runtime: new ServerRuntimeService({
        bus: this.bus,
        identity,
        uplinks,
        sdk,
        peerLinkService,
        inboxClaimant,
        expectedNodePublicKeyB64,
        logger,
      }),
      session: new ServerSessionService({
        bus: this.bus,
        storageProvider: this.#storageProvider,
        ownerAccountId: this.#ownerAccountId,
        logger,
      }),
      threads: new ServerThreadsService({
        bus: this.bus,
        threadStore: this.bus.stores.threadStore,
        threadIndex: this.bus.stores.threadIndex,
        contactStore: this.bus.stores.contactStore,
        groupStore: this.bus.stores.groupStore,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      messages: new ServerMessagesService({
        bus: this.bus,
        threadStore: this.bus.stores.threadStore,
        threadIndex: this.bus.stores.threadIndex,
        groupStore: this.bus.stores.groupStore,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      contacts: new ServerContactsService({
        bus: this.bus,
        contactStore: this.bus.stores.contactStore,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      groups: new ServerGroupsService({
        bus: this.bus,
        groupStore: this.bus.stores.groupStore,
        threadStore: this.bus.stores.threadStore,
        threadIndex: this.bus.stores.threadIndex,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      channels: new ServerChannelsService({
        bus: this.bus,
        channelStore: this.bus.stores.channelStore,
        groupStore: this.bus.stores.groupStore,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      invites: new ServerInvitesService({
        bus: this.bus,
        logger,
      }),
      connection: new ServerConnectionService({
        bus: this.bus,
        logger,
      }),
      fileTransfer: new ServerFileTransferService({
        bus: this.bus,
        storageProvider: this.#storageProvider,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      profile: new ServerProfileService({
        bus: this.bus,
        contactStore: this.bus.stores.contactStore,
        threadStore: this.bus.stores.threadStore,
        storageProvider: this.#storageProvider,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      links: new ServerLinksService({
        bus: this.bus,
        linkPreviewStore: this.bus.stores.linkPreviewStore,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      events: new ServerEventService({
        bus: this.bus,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
      peerLinkProtocol: new ServerPeerLinkProtocolService({
        bus: this.bus,
        ownerAccountId: this.#ownerAccountId,
        clock,
        logger,
      }),
    };
    // The single serialized inbound path. Both the live SDK push
    // (MailboxPushBridge) and the catch-up drain (InboxCatchupService) feed
    // deposits through this one pipeline so each is fully applied before the
    // next — no fire-and-forget emit, no ordering race. Not a lifecycle service
    // (no start/stop); registered on the bus for the bridge + catch-up to reach.
    // Persisted (mailbox,event) dedup shared by the pipeline (check + mark) and
    // the catch-up drain (prune past the cursor). Stops a cold-boot drain from
    // re-decrypting a deposit already consumed via the live push path — a
    // re-decrypt fails the advanced double ratchet and used to swallow the next
    // (genuinely new) offline message.
    const processedLog = new ProcessedDepositLog({ kvStore: this.#storageProvider.getKeyValueStore(null) });
    const inboundPipeline = new InboundDepositPipeline({
      peerLinkProtocol: services.peerLinkProtocol,
      events: services.events,
      processedLog,
      logger,
    });
    // Catchup is only meaningful when an inbox is claimed (production). In
    // unit-test paths that wire ChatServerApp without an inboxClaimant the
    // SDK push bridge is also not engaged, so nothing to drain. Added last
    // so its start() runs after the live-push subscribers have wired up.
    if (inboxClaimant) {
      services.inboxCatchup = new InboxCatchupService({
        bus: this.bus,
        inboxClaimant,
        inboundPipeline,
        processedLog,
        logger,
      });
    }
    Object.assign(this.bus.services, services, { inboundPipeline });
    this.#services = Object.values(services);
  }
}
