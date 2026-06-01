import { Host } from "@rezprotocol/ui/framework";
import { IndexedDbStorageProvider } from "@rezprotocol/sdk/client";
import { ChatBus } from "./ChatBus.js";
import { SessionStore, SESSION_STATUS } from "../stores/SessionStore.js";
import { AuthStore } from "../stores/AuthStore.js";
import { UiStateStore } from "../stores/UiStateStore.js";
import { ThreadStore } from "../stores/ThreadStore.js";
import { MessageStore } from "../stores/MessageStore.js";
import { ContactStore } from "../stores/ContactStore.js";
import { GroupStore } from "../stores/GroupStore.js";
import { ChannelStore } from "../stores/ChannelStore.js";
import { InviteStore } from "../stores/InviteStore.js";
import { ConnectionStore } from "../stores/ConnectionStore.js";
import { GroupQueries } from "../queries/GroupQueries.js";
import { ThreadQueries } from "../queries/ThreadQueries.js";
import { ChannelQueries } from "../queries/ChannelQueries.js";
import { ContactQueries } from "../queries/ContactQueries.js";
import { MessageQueries } from "../queries/MessageQueries.js";
import { AccountRegistry } from "../services/AccountRegistry.js";
import { AuthBootstrapService } from "../services/auth/AuthBootstrapService.js";
import { AccountAuthService } from "../services/auth/AccountAuthService.js";
import { SdkSessionService } from "../services/auth/SdkSessionService.js";
import { createAuthCryptoProvider } from "../services/auth/createAuthCryptoProvider.js";
import {
  DesktopAccountAuthService,
  DesktopAuthBootstrapService,
  hasDesktopRuntimeBridge,
} from "../services/auth/DesktopAuthServices.js";
import { LoginUnlockScene } from "../scenes/LoginUnlockScene.js";
import { LoginCreateAccountScene } from "../scenes/LoginCreateAccountScene.js";
import { SplashScene } from "../scenes/SplashScene.js";
import { MainScene } from "../scenes/MainScene.js";
import { AuthScreenService } from "../services/bus/AuthScreenService.js";
import { SessionService } from "../services/bus/SessionService.js";
import { RuntimeService } from "../services/bus/RuntimeService.js";
import { ThreadsService } from "../services/bus/ThreadsService.js";
import { MessagesService } from "../services/bus/MessagesService.js";
import { ContactsService } from "../services/bus/ContactsService.js";
import { GroupsService } from "../services/bus/GroupsService.js";
import { ChannelsService } from "../services/bus/ChannelsService.js";
import { InvitesService } from "../services/bus/InvitesService.js";
import { ConnectionService } from "../services/bus/ConnectionService.js";
import { NotificationService } from "../services/bus/NotificationService.js";
import { UiNavigationService } from "../services/bus/UiNavigationService.js";
import { LinksService } from "../services/bus/LinksService.js";
import { UpdateAvailableBannerView } from "../views/UpdateAvailableBannerView.js";

export class ChatApp {
  constructor({
    mountEl,
    theme = {},
    sdkFactory = null,
    storageProvider = null,
    logger = console,
  } = {}) {
    if (!(mountEl instanceof Element)) {
      throw new Error("ChatApp requires mountEl");
    }
    this._mountEl = mountEl;
    this._theme = theme && typeof theme === "object" ? theme : {};
    this._logger = logger || console;
    this._storageProvider = storageProvider && typeof storageProvider.get === "function" && typeof storageProvider.put === "function"
      ? storageProvider
      : new IndexedDbStorageProvider();
    this.bus = new ChatBus({ config: { theme: this._theme }, logger: this._logger });
    this._createStores();
    this._createQueries();
    this._createServices(sdkFactory);
    this._createHost();
    this._updateBanner = new UpdateAvailableBannerView();
    this._updateBanner.start();
    this._offSession = this.bus.stores.session.onChange(() => this._syncSceneFromSession());
    this._offUiState = this.bus.stores.uiState.onChange(() => this._syncSceneFromSession());
  }

  _createStores() {
    this.bus.stores.session = new SessionStore({ bus: this.bus });
    this.bus.stores.auth = new AuthStore({ bus: this.bus });
    this.bus.stores.uiState = new UiStateStore({ bus: this.bus });
    // Stores receive `bus` only for error surfacing — they do NOT read
    // peer stores. Cross-store derivation lives in src/ui/queries/.
    this.bus.stores.threads = new ThreadStore({ bus: this.bus });
    this.bus.stores.messages = new MessageStore({ bus: this.bus });
    this.bus.stores.contacts = new ContactStore({ bus: this.bus });
    this.bus.stores.groups = new GroupStore({ bus: this.bus });
    this.bus.stores.channels = new ChannelStore({ bus: this.bus });
    this.bus.stores.invites = new InviteStore({ bus: this.bus });
    this.bus.stores.connection = new ConnectionStore({ bus: this.bus });
  }

  _createQueries() {
    const stores = this.bus.stores;
    this.bus.queries = {
      groups: new GroupQueries({ stores }),
      threads: new ThreadQueries({ stores }),
      channels: new ChannelQueries({ stores }),
      contacts: new ContactQueries({ stores }),
      messages: new MessageQueries({ stores }),
    };
  }

  _createServices(sdkFactory) {
    const storageProvider = this._storageProvider;
    const useDesktopRuntime = hasDesktopRuntimeBridge();
    const hasStorage = storageProvider && typeof storageProvider.get === "function" && typeof storageProvider.put === "function";
    const accountRegistry = useDesktopRuntime ? null : hasStorage ? new AccountRegistry({ storageProvider }) : null;
    const authBootstrapService = useDesktopRuntime
      ? new DesktopAuthBootstrapService({
        authStore: this.bus.stores.auth,
        logger: this._logger,
      })
      : new AuthBootstrapService({
        authStore: this.bus.stores.auth,
        storageProvider: hasStorage ? storageProvider : null,
        accountRegistry,
        logger: this._logger,
      });
    const accountAuthService = useDesktopRuntime
      ? new DesktopAccountAuthService({
        authStore: this.bus.stores.auth,
        authBootstrapService,
      })
      : new AccountAuthService({
        authStore: this.bus.stores.auth,
        authBootstrapService,
        cryptoProvider: createAuthCryptoProvider(),
        logger: this._logger,
      });
    const sdkSessionService = new SdkSessionService({
      authStore: this.bus.stores.auth,
      accountAuthService,
      sdkClientFactory: sdkFactory,
      logger: this._logger,
    });
    this.bus.services.accountRegistry = accountRegistry;
    this.bus.services.authBootstrap = authBootstrapService;
    this.bus.services.accountAuth = accountAuthService;
    this.bus.services.sdkSession = sdkSessionService;
    const services = {
      session: new SessionService({
        bus: this.bus,
        authBootstrapService,
        accountAuthService,
        authStore: this.bus.stores.auth,
        sessionStore: this.bus.stores.session,
        logger: this._logger,
      }),
      authScreen: new AuthScreenService({
        bus: this.bus,
        sessionStore: this.bus.stores.session,
        uiStateStore: this.bus.stores.uiState,
      }),
      runtime: new RuntimeService({
        bus: this.bus,
        sdkSessionService,
        connectionStore: this.bus.stores.connection,
        logger: this._logger,
      }),
      threads: new ThreadsService({
        bus: this.bus,
        threadStore: this.bus.stores.threads,
        messageStore: this.bus.stores.messages,
        uiStateStore: this.bus.stores.uiState,
      }),
      messages: new MessagesService({
        bus: this.bus,
        messageStore: this.bus.stores.messages,
      }),
      contacts: new ContactsService({
        bus: this.bus,
        contactStore: this.bus.stores.contacts,
      }),
      groups: new GroupsService({
        bus: this.bus,
        groupStore: this.bus.stores.groups,
      }),
      channels: new ChannelsService({
        bus: this.bus,
        channelStore: this.bus.stores.channels,
      }),
      invites: new InvitesService({
        bus: this.bus,
        inviteStore: this.bus.stores.invites,
      }),
      connection: new ConnectionService({
        bus: this.bus,
        connectionStore: this.bus.stores.connection,
      }),
      notifications: new NotificationService({
        bus: this.bus,
        uiStateStore: this.bus.stores.uiState,
      }),
      uiNavigation: new UiNavigationService({
        bus: this.bus,
        uiStateStore: this.bus.stores.uiState,
      }),
      links: new LinksService({
        bus: this.bus,
      }),
    };
    Object.assign(this.bus.services, services);
    this._services = [
      authBootstrapService,
      accountAuthService,
      sdkSessionService,
      ...Object.values(services),
    ];
  }

  _createHost() {
    this._host = new Host({
      children: {
        "login-unlock": () => new LoginUnlockScene({ bus: this.bus }),
        "login-create": () => new LoginCreateAccountScene({ bus: this.bus }),
        splash: () => new SplashScene({ bus: this.bus }),
        main: () => new MainScene({ bus: this.bus }),
      },
    });
    this._host.mount(this._mountEl);
    this.bus.ui.host = this._host;
  }

  _syncSceneFromSession() {
    const snap = this.bus.stores.session.snapshot();
    const uiSnap = this.bus.stores.uiState.snapshot();
    const hasAccounts = Array.isArray(snap && snap.accountList) && snap.accountList.length > 0;
    let sceneName = "login-unlock";
    if (snap.status === SESSION_STATUS.UNLOCKED) {
      sceneName = "main";
    } else if (snap.status === SESSION_STATUS.INITIALIZING) {
      sceneName = "splash";
    } else if (snap.status === SESSION_STATUS.NO_KEYSTORE || !hasAccounts) {
      sceneName = "login-create";
    } else if (String(uiSnap && uiSnap.authScreen || "unlock") === "create") {
      sceneName = "login-create";
    }
    this._host.switchTo(sceneName);
    this.bus.emit("scene.changed", { sceneName });
  }

  async start() {
    this.bus.emit("app.starting", {});
    await this.bus.services.session.init();
    this._syncSceneFromSession();
    this.bus.resolveReady.app();
    this.bus.emit("app.ready", {});
  }

  async stop() {
    if (typeof this._offSession === "function") {
      this._offSession();
      this._offSession = null;
    }
    if (typeof this._offUiState === "function") {
      this._offUiState();
      this._offUiState = null;
    }
    if (this._updateBanner) {
      this._updateBanner.stop();
      this._updateBanner = null;
    }
    for (const service of this._services || []) {
      if (service && typeof service.stop === "function") {
        service.stop();
      }
    }
    if (this._host) {
      this._host.unmount();
      this._host = null;
    }
  }
}
