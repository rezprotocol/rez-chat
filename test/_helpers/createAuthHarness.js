import { SessionStore } from "../../src/ui/stores/SessionStore.js";
import { AccountRegistry } from "../../src/ui/services/AccountRegistry.js";
import { AuthBootstrapService } from "../../src/ui/services/auth/AuthBootstrapService.js";
import { AccountAuthService } from "../../src/ui/services/auth/AccountAuthService.js";
import { SdkSessionService } from "../../src/ui/services/auth/SdkSessionService.js";

export function createAuthHarness({
  storageProvider = null,
  authStore = null,
  sessionStore = null,
  accountRegistry = undefined,
  keystoreStore = null,
  sdkClientFactory = null,
  sdkClient = null,
  cryptoProvider = null,
  logger = console,
} = {}) {
  // The auth lifecycle now writes the single SessionStore directly (AuthStore
  // was removed). `authStore` is accepted + returned as an alias of the
  // SessionStore so existing callers/assertions keep working.
  const resolvedStore = sessionStore || authStore || new SessionStore();
  let resolvedAccountRegistry = accountRegistry;
  if (resolvedAccountRegistry === undefined) {
    const hasStorage = storageProvider && typeof storageProvider.get === "function" && typeof storageProvider.put === "function";
    resolvedAccountRegistry = hasStorage && !keystoreStore ? new AccountRegistry({ storageProvider }) : null;
  }
  const authBootstrapService = new AuthBootstrapService({
    sessionStore: resolvedStore,
    storageProvider,
    accountRegistry: resolvedAccountRegistry,
    keystoreStore,
    logger,
  });
  const accountAuthService = new AccountAuthService({
    sessionStore: resolvedStore,
    authBootstrapService,
    cryptoProvider,
    logger,
  });
  const sdkSessionService = new SdkSessionService({
    accountAuthService,
    sdkClientFactory,
    sdkClient,
    logger,
  });
  return {
    authStore: resolvedStore,
    sessionStore: resolvedStore,
    accountRegistry: resolvedAccountRegistry,
    authBootstrapService,
    accountAuthService,
    sdkSessionService,
    async init() {
      return authBootstrapService.init();
    },
    async listAccounts() {
      return authBootstrapService.listAccounts();
    },
    selectAccount(payload) {
      return authBootstrapService.selectAccount(payload);
    },
    async inspectBootstrap() {
      return authBootstrapService.inspectBootstrap();
    },
    async createAccount(payload) {
      return accountAuthService.createAccount(payload);
    },
    async unlock(payload) {
      return accountAuthService.unlock(payload);
    },
    async logout() {
      await sdkSessionService.disconnect();
      return accountAuthService.logout();
    },
    getAccount() {
      return accountAuthService.getAccount();
    },
    async connectClient() {
      return sdkSessionService.connectClient();
    },
    getClient() {
      return sdkSessionService.getClient();
    },
    getSessionHandles() {
      return sdkSessionService.getSessionHandles();
    },
    async disconnectClient() {
      return sdkSessionService.disconnect();
    },
  };
}
