import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { ellipsisId } from "../presenters/labels.js";

const STAT_LABEL_CLASS = "text-label-micro font-label-technical text-outline uppercase tracking-wider";
const STAT_VALUE_CLASS = "text-label-technical font-label-technical text-on-surface-variant truncate";
const CARD_CLASS = "bg-surface-container-low border border-outline-variant/30 rounded-lg p-space-md text-label-technical font-label-technical text-on-surface-variant flex flex-col gap-space-sm";

function formatDateTime(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "Never";
  return new Date(num).toLocaleString();
}

export class SettingsTabView extends BusComponent {
  constructor({ bus } = {}) {
    super({ bus });
    this._sidebarEl = null;
    this._mainEl = null;
    this._appVersion = "";
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this._sidebarEl = h("aside", {
      className: "hidden md:flex w-thread-list-width shrink-0 flex-col border-r border-outline-variant/30 bg-surface-container-lowest/50 backdrop-blur-sm",
    }, []);
    this._mainEl = h("section", { className: "flex-1 min-w-0 flex flex-col relative chat-canvas-recessed" }, []);
    this._rootEl.replaceChildren(h("div", { className: "flex h-full w-full min-h-0" }, [this._sidebarEl, this._mainEl]));
    this._subscribe(this.bus.stores.connection, () => {
      this._renderSidebar();
      this._renderMain();
    });
    this._renderSidebar();
    this._renderMain();
    this._loadAppVersion();
  }

  // The desktop app exposes its version via the rezDesktop bridge
  // (electron main: app.getVersion() over the desktop:getAppInfo IPC). It is
  // async and absent in the web build, so fetch once and re-render on arrival.
  _loadAppVersion() {
    const desktop = typeof window !== "undefined" && window.rezDesktop ? window.rezDesktop : null;
    if (!desktop || typeof desktop.getAppInfo !== "function") return;
    Promise.resolve(desktop.getAppInfo()).then((info) => {
      const version = info && typeof info.appVersion === "string" ? info.appVersion.trim() : "";
      if (!version || version === this._appVersion) return;
      this._appVersion = version;
      this._renderSidebar();
      this._renderMain();
    }).catch((err) => {
      console.error("[SettingsTabView] getAppInfo failed", err);
    });
  }

  _renderSidebar() {
    if (!this._sidebarEl) return;
    this._sidebarEl.replaceChildren();
    const stores = this.bus.stores;
    const current = stores.connection.getConnection();
    const accountId = stores.session.vaultAccountId() || "Unknown";
    const deviceId = stores.session.deviceId() || "—";
    const activeNode = String(current && current.activeNode || "").trim();
    const nodes = Array.isArray(current && current.nodes) ? current.nodes : [];
    const connectedNodes = nodes.filter((node) => node && node.ready === true && node.healthy === true);
    const mesh = current && current.mesh && typeof current.mesh === "object" ? current.mesh : {};
    const meshPeers = Array.isArray(mesh.peers) ? mesh.peers : [];
    const meshPeerCount = Number.isFinite(Number(mesh.peerCount)) ? Number(mesh.peerCount) : meshPeers.length;
    const nodeLabel = activeNode || "Not connected";

    this._sidebarEl.appendChild(h("div", { className: "p-space-lg pb-space-md titlebar-drag" }, [
      h("h1", { className: "text-headline-md font-headline-md text-on-surface" }, "System"),
    ]));
    this._sidebarEl.appendChild(h("div", { className: "px-space-lg py-space-md flex flex-col gap-space-sm" }, [
      h("p", { className: STAT_VALUE_CLASS, "data-testid": "system.app-version" }, "Version: " + (this._appVersion || "—")),
      h("p", { className: STAT_VALUE_CLASS }, "Account: " + ellipsisId(accountId, 20)),
      h("p", { className: STAT_VALUE_CLASS }, "Device: " + ellipsisId(deviceId, 20)),
      h("p", { className: STAT_VALUE_CLASS, "data-testid": "system.connected-node" }, "Node: " + nodeLabel),
      h("p", { className: STAT_VALUE_CLASS, "data-testid": "system.connected-nodes-count" }, "Connected nodes: " + String(connectedNodes.length)),
      h("p", { className: STAT_VALUE_CLASS, "data-testid": "system.mesh-peer-count" }, "Mesh peers: " + String(meshPeerCount)),
    ]));
  }

  _renderMain() {
    if (!this._mainEl) return;
    this._mainEl.replaceChildren();
    const current = this.bus.stores.connection.getConnection();
    const activeNode = String(current && current.activeNode || "").trim();
    const nodes = Array.isArray(current && current.nodes) ? current.nodes : [];
    const mesh = current && current.mesh && typeof current.mesh === "object" ? current.mesh : {};
    const meshPeers = Array.isArray(mesh.peers) ? mesh.peers : [];
    const nodeLabel = activeNode || "Not connected";
    const seedEntries = Object.entries(mesh && mesh.seedReachable && typeof mesh.seedReachable === "object" ? mesh.seedReachable : {});
    const backup = current && current.backup && typeof current.backup === "object" ? current.backup : {};
    const wrapper = h("div", { className: "p-space-xl flex flex-col gap-space-lg max-w-3xl overflow-y-auto custom-scrollbar h-full" }, [
      h("h3", { className: "text-headline-md font-headline-md text-on-surface" }, "System Settings"),
      h("p", {
        className: "text-label-technical font-label-technical text-on-surface-variant/70 -mt-space-sm",
        "data-testid": "system.app-version.main",
      }, "Version " + (this._appVersion || "—")),
      h("div", {
        className: CARD_CLASS,
        "data-testid": "system.connected-node-url",
      }, "Connected node: " + nodeLabel),
      h("div", {
        className: CARD_CLASS,
        "data-testid": "system.connected-nodes",
      }, [
        h("p", { className: STAT_LABEL_CLASS }, "Uplink nodes"),
        ...(nodes.length > 0
          ? nodes.map((node) => {
              const url = String(node && node.url || "").trim() || "unknown";
              const active = node && node.active === true;
              const ready = node && node.ready === true;
              const healthy = node && node.healthy === true;
              const status = active
                ? "active"
                : (ready && healthy ? "warm-spare" : "disconnected");
              return h("p", {
                className: "truncate text-label-technical font-label-technical text-on-surface-variant",
                "data-testid": active ? "system.node.active" : "system.node.entry",
                title: url,
              }, status + " · " + url);
            })
          : [h("p", { className: "text-on-surface-variant/60 text-label-technical font-label-technical", "data-testid": "system.node.none" }, "No uplinks reported")]),
      ]),
      h("div", {
        className: CARD_CLASS,
        "data-testid": "system.mesh",
      }, [
        h("div", { className: "flex items-center justify-between gap-space-sm" }, [
          h("p", { className: STAT_LABEL_CLASS }, "Reznet mesh"),
          h("button", {
            type: "button",
            className: "px-space-sm py-1 rounded border border-outline-variant/40 text-label-micro font-label-technical text-on-surface-variant hover:text-primary hover:border-primary/40 transition-colors",
            "data-action": "mesh.refresh",
          }, "Refresh"),
        ]),
        h("p", {
          className: "text-label-technical font-label-technical text-on-surface-variant",
          "data-testid": "system.mesh.summary",
        }, [
          "enabled=", mesh && mesh.enabled === true ? "yes" : "no",
          " · mode=", String(mesh && mesh.mode || "seeded-gossip"),
          " · routing=", mesh && mesh.participateInRouting === true ? "on" : "off",
        ].join("")),
        h("p", {
          className: "text-label-technical font-label-technical text-on-surface-variant",
          "data-testid": "system.mesh.last-discovery",
        }, "Last discovery: " + formatDateTime(mesh && mesh.lastDiscoveryAtMs)),
        ...(seedEntries.length > 0
          ? [
              h("p", { className: STAT_LABEL_CLASS + " mt-1" }, "Seeds"),
              ...seedEntries.map(([seed, reachable]) => h("p", {
                className: "truncate text-label-technical font-label-technical text-on-surface-variant",
                "data-testid": "system.mesh.seed",
                title: seed,
              }, (reachable ? "up" : "down") + " · " + seed)),
            ]
          : [h("p", { className: "text-on-surface-variant/60 text-label-technical font-label-technical", "data-testid": "system.mesh.seed.none" }, "No seed status reported")]),
        h("p", { className: STAT_LABEL_CLASS + " mt-1" }, "Peers"),
        ...(meshPeers.length > 0
          ? meshPeers.map((peer) => {
              const nodeId = String(peer && peer.nodeId || "").trim() || "unknown";
              const health = String(peer && peer.health || "unknown");
              const transport = String(peer && peer.transport || "unknown");
              const source = String(peer && peer.source || "unknown");
              return h("p", {
                className: "truncate text-label-technical font-label-technical text-on-surface-variant",
                "data-testid": "system.mesh.peer",
                title: nodeId,
              }, health + " · " + transport + " · " + source + " · " + nodeId);
            })
          : [h("p", { className: "text-on-surface-variant/60 text-label-technical font-label-technical", "data-testid": "system.mesh.peer.none" }, "No mesh peers reported")]),
      ]),
      h("section", {
        className: "bg-surface-container-low border border-outline-variant/30 rounded-lg p-space-lg flex flex-col gap-space-sm",
        "data-testid": "system.backup.section",
      }, [
        h("h4", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Encrypted Backup"),
        h("p", { className: "text-label-technical font-label-technical text-on-surface-variant" }, backup && backup.enabled === true ? "Status: enabled" : "Status: disabled"),
        h("p", { className: "text-label-technical font-label-technical text-on-surface-variant/70" }, "Last backup: " + formatDateTime(backup && backup.lastBackupAtMs)),
        h("p", { className: "text-label-technical font-label-technical text-on-surface-variant/70" }, "Retention: " + (Number.isFinite(Number(backup && backup.retentionDays)) ? String(Number(backup.retentionDays)) + " days" : "Unknown")),
        h("p", { className: "text-label-technical font-label-technical text-on-surface-variant/70" }, "Checkpoint seq: " + (Number.isFinite(Number(backup && backup.checkpointVersion)) ? String(Number(backup.checkpointVersion)) : "None")),
      ]),
      h("button", {
        type: "button",
        className: "px-space-md py-2 rounded-lg border border-outline-variant/40 text-label-technical font-label-technical text-on-surface-variant hover:text-primary hover:border-primary/40 transition-colors w-fit",
        "data-action": "mesh.refresh",
      }, "Refresh mesh status"),
    ]);
    this._mainEl.appendChild(wrapper);
    const refreshActions = wrapper.querySelectorAll("[data-action='mesh.refresh']");
    for (const actionRefresh of refreshActions) {
      actionRefresh.addEventListener("click", () => {
        this.bus.call("mesh", "refresh", {}).catch((err) => {
          console.error("[SettingsTabView] mesh refresh failed", err);
          this.bus.emit("app.error", { source: "SettingsTabView", message: "mesh refresh failed", severity: "info", err });
        });
      });
    }
  }

  unmount() {
    this._sidebarEl = null;
    this._mainEl = null;
    super.unmount();
  }
}
