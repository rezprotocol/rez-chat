import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";

const VALID_TABS = new Set(["chat", "contacts", "settings", "profile"]);

/**
 * UiNavigationService: the canonical directive surface for "switch what's
 * mounted." Every user-directed navigation goes through here.
 *
 * Click handlers do exactly one thing: bus.call("ui", "<directive>", {...}).
 * Stores update internally. Hosts subscribe to the relevant store fields and
 * mount/unmount their child Components in response. No view ever calls
 * uiStateStore.set* directly.
 */
export class UiNavigationService extends BaseBusService {
  #uiStateStore;

  constructor({ bus, uiStateStore } = {}) {
    super({ bus });
    if (!uiStateStore) throw new Error("UiNavigationService requires uiStateStore");
    this.#uiStateStore = uiStateStore;
    this._register("ui", "navigateTab", (payload) => this.navigateTab(payload));
    this._register("ui", "selectContactGroup", (payload) => this.selectContactGroup(payload));
    this._register("ui", "setThreadListFilters", (payload) => this.setThreadListFilters(payload));
    this._register("ui", "selectChannel", (payload) => this.selectChannel(payload));
  }

  navigateTab({ to } = {}) {
    const target = String(to || "").trim().toLowerCase();
    if (!VALID_TABS.has(target)) return null;
    this.#uiStateStore.setActiveTab(target);
    return { activeTab: target };
  }

  selectContactGroup({ groupId } = {}) {
    const id = nonEmptyString(groupId) || null;
    this.#uiStateStore.setSelectedContactGroupId(id);
    return { groupId: id };
  }

  setThreadListFilters({ filters } = {}) {
    if (!Array.isArray(filters)) return null;
    this.#uiStateStore.setThreadListFilters(filters);
    return { filters: this.#uiStateStore.snapshot().threadListFilters };
  }

  selectChannel({ threadId, channelId } = {}) {
    const tid = nonEmptyString(threadId);
    if (!tid) return null;
    const cid = typeof channelId === "string" ? channelId.trim() : "";
    this.#uiStateStore.setSelectedChannelId(tid, cid);
    return { threadId: tid, channelId: cid };
  }

}
