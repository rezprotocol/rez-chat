import {
  SessionHelloParams,
  ThreadsListParams,
  ThreadGetParams,
  ThreadMessagesListParams,
  ThreadReadParams,
  ThreadChannelReadParams,
  ThreadStateSetParams,
  ThreadDeleteParams,
  MessageSendParams,
  MessageEditParams,
  MessageTombstoneParams,
  MessageDeleteLocalParams,
  MessageReactionAddParams,
  MessageReactionRemoveParams,
  ContactsListParams,
  ContactsRenameParams,
  ContactsBlockParams,
  ContactsUnblockParams,
  ContactsDeleteParams,
  InviteCreateParams,
  InviteAcceptParams,
  PeerLinksListParams,
  PeerLinkGetParams,
  NodeStatusParams,
  MeshStatusParams,
  KeystorePutParams,
  KeystoreFetchParams,
  GroupCreateParams,
  GroupsListParams,
  GroupMembersListParams,
  GroupLeaveParams,
  GroupRenameParams,
  GroupKickParams,
  GroupSetRoleParams,
  ChannelsListParams,
  ChannelsCreateParams,
  ChannelsDeleteParams,
  ChannelsSyncAllParams,
  SessionHelloResult,
  ThreadsListResult,
  ThreadGetResult,
  ThreadMessagesListResult,
  ThreadReadResult,
  ThreadChannelReadResult,
  ThreadStateSetResult,
  ThreadDeleteResult,
  MessageSendResult,
  MessageEditResult,
  MessageTombstoneResult,
  MessageDeleteLocalResult,
  MessageReactionAddResult,
  MessageReactionRemoveResult,
  ContactsListResult,
  ContactsRenameResult,
  ContactsBlockResult,
  ContactsUnblockResult,
  ContactsDeleteResult,
  InviteCreateResult,
  InviteAcceptResult,
  PeerLinksListResult,
  PeerLinkGetResult,
  NodeStatusResult,
  MeshStatusResult,
  KeystorePutResult,
  KeystoreFetchResult,
  GroupCreateResult,
  GroupsListResult,
  GroupMembersListResult,
  GroupLeaveResult,
  GroupRenameResult,
  GroupKickResult,
  GroupSetRoleResult,
  ChannelsListResult,
  ChannelsCreateResult,
  ChannelsDeleteResult,
  ChannelsSyncAllResult,
  ThreadCreateDirectParams,
  FileSendParams,
  FileSendResult,
  FileGetParams,
  FileGetResult,
  ProfileBroadcastParams,
  ProfileBroadcastResult,
  ProfileGetOwnParams,
  ProfileGetOwnResult,
  LinksUnfurlParams,
  LinksUnfurlResult,
  MessageDepositedEvent,
  MessageStatusEvent,
  MessageUpdatedEvent,
  MessageRemovedEvent,
  ThreadIndexUpdatedEvent,
  PeerLinkUpdatedEvent,
  ContactUpdatedEvent,
  ConnectionStateEvent,
  MeshStatusUpdatedEvent,
  GroupUpdatedEvent,
  GroupRemovedEvent,
  GroupMembersUpdatedEvent,
  ChannelUpsertedEvent,
  ChannelRemovedEvent,
} from "../../records/index.js";

export const CHAT_BRIDGE_SPEC = {
  namespace: "chat",
  methods: {
    "session.hello": { params: SessionHelloParams, result: SessionHelloResult },
    "threads.list": { params: ThreadsListParams, result: ThreadsListResult },
    "thread.get": { params: ThreadGetParams, result: ThreadGetResult },
    "thread.messages.list": { params: ThreadMessagesListParams, result: ThreadMessagesListResult },
    "thread.read": { params: ThreadReadParams, result: ThreadReadResult },
    "thread.channel.read": { params: ThreadChannelReadParams, result: ThreadChannelReadResult },
    "thread.state.set": { params: ThreadStateSetParams, result: ThreadStateSetResult },
    "thread.delete": { params: ThreadDeleteParams, result: ThreadDeleteResult },
    "thread.createDirect": { params: ThreadCreateDirectParams, result: ThreadGetResult },
    "message.send": { params: MessageSendParams, result: MessageSendResult },
    "message.edit": { params: MessageEditParams, result: MessageEditResult },
    "message.tombstone": { params: MessageTombstoneParams, result: MessageTombstoneResult },
    "message.deleteLocal": { params: MessageDeleteLocalParams, result: MessageDeleteLocalResult },
    "message.reaction.add": { params: MessageReactionAddParams, result: MessageReactionAddResult },
    "message.reaction.remove": { params: MessageReactionRemoveParams, result: MessageReactionRemoveResult },
    "contacts.list": { params: ContactsListParams, result: ContactsListResult },
    "contacts.rename": { params: ContactsRenameParams, result: ContactsRenameResult },
    "contacts.block": { params: ContactsBlockParams, result: ContactsBlockResult },
    "contacts.unblock": { params: ContactsUnblockParams, result: ContactsUnblockResult },
    "contacts.delete": { params: ContactsDeleteParams, result: ContactsDeleteResult },
    "invite.create": { params: InviteCreateParams, result: InviteCreateResult },
    "invite.accept": { params: InviteAcceptParams, result: InviteAcceptResult },
    "peer-links.list": { params: PeerLinksListParams, result: PeerLinksListResult },
    "peer-link.get": { params: PeerLinkGetParams, result: PeerLinkGetResult },
    "node.status": { params: NodeStatusParams, result: NodeStatusResult },
    "mesh.refresh": { params: MeshStatusParams, result: MeshStatusResult },
    "mesh.status": { params: MeshStatusParams, result: MeshStatusResult },
    "keystore.put": { params: KeystorePutParams, result: KeystorePutResult },
    "keystore.fetch": { params: KeystoreFetchParams, result: KeystoreFetchResult },
    "group.create": { params: GroupCreateParams, result: GroupCreateResult },
    "groups.list": { params: GroupsListParams, result: GroupsListResult },
    "group.members.list": { params: GroupMembersListParams, result: GroupMembersListResult },
    "group.leave": { params: GroupLeaveParams, result: GroupLeaveResult },
    "group.rename": { params: GroupRenameParams, result: GroupRenameResult },
    "group.kick": { params: GroupKickParams, result: GroupKickResult },
    "group.setRole": { params: GroupSetRoleParams, result: GroupSetRoleResult },
    "channels.list": { params: ChannelsListParams, result: ChannelsListResult },
    "channels.create": { params: ChannelsCreateParams, result: ChannelsCreateResult },
    "channels.delete": { params: ChannelsDeleteParams, result: ChannelsDeleteResult },
    "channels.syncAll": { params: ChannelsSyncAllParams, result: ChannelsSyncAllResult },
    "file.send": { params: FileSendParams, result: FileSendResult },
    "file.get": { params: FileGetParams, result: FileGetResult },
    "profile.broadcast": { params: ProfileBroadcastParams, result: ProfileBroadcastResult },
    "profile.getOwn": { params: ProfileGetOwnParams, result: ProfileGetOwnResult },
    "links.unfurl": { params: LinksUnfurlParams, result: LinksUnfurlResult },
  },
  events: {
    "message.deposited": MessageDepositedEvent,
    "message.status": MessageStatusEvent,
    "message.updated": MessageUpdatedEvent,
    "message.removed": MessageRemovedEvent,
    "thread.index.updated": ThreadIndexUpdatedEvent,
    "peer-link.updated": PeerLinkUpdatedEvent,
    "contact.updated": ContactUpdatedEvent,
    "connection.state": ConnectionStateEvent,
    "mesh.updated": MeshStatusUpdatedEvent,
    "group.updated": GroupUpdatedEvent,
    "group.removed": GroupRemovedEvent,
    "group.members.updated": GroupMembersUpdatedEvent,
    "channel.upserted": ChannelUpsertedEvent,
    "channel.removed": ChannelRemovedEvent,
  },
};

export const CHAT_BRIDGE_METHOD_BINDINGS = Object.freeze({
  "session.hello": { namespace: "session", name: "hello", result: SessionHelloResult },
  "threads.list": { namespace: "threads", name: "list", result: ThreadsListResult },
  "thread.get": { namespace: "thread", name: "get", result: ThreadGetResult },
  "thread.messages.list": { namespace: "thread.messages", name: "list", result: ThreadMessagesListResult },
  "thread.read": { namespace: "thread", name: "read", result: ThreadReadResult },
  "thread.channel.read": { namespace: "thread.channel", name: "read", result: ThreadChannelReadResult },
  "thread.state.set": { namespace: "thread.state", name: "set", result: ThreadStateSetResult },
  "thread.delete": { namespace: "thread", name: "delete", result: ThreadDeleteResult },
  "thread.createDirect": { namespace: "thread", name: "createDirect", result: ThreadGetResult },
  "message.send": { namespace: "message", name: "send", result: MessageSendResult },
  "message.edit": { namespace: "message", name: "edit", result: MessageEditResult },
  "message.tombstone": { namespace: "message", name: "tombstone", result: MessageTombstoneResult },
  "message.deleteLocal": { namespace: "message", name: "deleteLocal", result: MessageDeleteLocalResult },
  "message.reaction.add": { namespace: "message.reaction", name: "add", result: MessageReactionAddResult },
  "message.reaction.remove": { namespace: "message.reaction", name: "remove", result: MessageReactionRemoveResult },
  "contacts.list": { namespace: "contacts", name: "list", result: ContactsListResult },
  "contacts.rename": { namespace: "contacts", name: "rename", result: ContactsRenameResult },
  "contacts.block": { namespace: "contacts", name: "block", result: ContactsBlockResult },
  "contacts.unblock": { namespace: "contacts", name: "unblock", result: ContactsUnblockResult },
  "contacts.delete": { namespace: "contacts", name: "delete", result: ContactsDeleteResult },
  "invite.create": { namespace: "invite", name: "create", result: InviteCreateResult },
  "invite.accept": { namespace: "invite", name: "accept", result: InviteAcceptResult },
  "peer-links.list": { namespace: "peer-links", name: "list", result: PeerLinksListResult },
  "peer-link.get": { namespace: "peer-link", name: "get", result: PeerLinkGetResult },
  "node.status": { namespace: "node", name: "status", result: NodeStatusResult },
  "mesh.refresh": { namespace: "mesh", name: "refresh", result: MeshStatusResult },
  "mesh.status": { namespace: "mesh", name: "status", result: MeshStatusResult },
  "keystore.put": { namespace: "keystore", name: "put", result: KeystorePutResult },
  "keystore.fetch": { namespace: "keystore", name: "fetch", result: KeystoreFetchResult },
  "group.create": { namespace: "group", name: "create", result: GroupCreateResult },
  "groups.list": { namespace: "groups", name: "list", result: GroupsListResult },
  "group.members.list": { namespace: "group.members", name: "list", result: GroupMembersListResult },
  "group.leave": { namespace: "group", name: "leave", result: GroupLeaveResult },
  "group.rename": { namespace: "group", name: "rename", result: GroupRenameResult },
  "group.kick": { namespace: "group", name: "kick", result: GroupKickResult },
  "group.setRole": { namespace: "group", name: "setRole", result: GroupSetRoleResult },
  "channels.list": { namespace: "channels", name: "list", result: ChannelsListResult },
  "channels.create": { namespace: "channels", name: "create", result: ChannelsCreateResult },
  "channels.delete": { namespace: "channels", name: "delete", result: ChannelsDeleteResult },
  "channels.syncAll": { namespace: "channels", name: "syncAll", result: ChannelsSyncAllResult },
  "file.send": { namespace: "file", name: "send", result: FileSendResult },
  "file.get": { namespace: "file", name: "get", result: FileGetResult },
  "profile.broadcast": { namespace: "profile", name: "broadcastUpdate", result: ProfileBroadcastResult },
  "profile.getOwn": { namespace: "profile", name: "getOwn", result: ProfileGetOwnResult },
  "links.unfurl": { namespace: "links", name: "unfurl", result: LinksUnfurlResult },
});

export class ChatBridge {
  #bus;
  #ownerAccountId;
  #logger;

  constructor({ bus = null, chatServer = null, ownerAccountId = "", logger = console } = {}) {
    const resolvedBus = bus || (chatServer && chatServer.bus ? chatServer.bus : null);
    const resolvedOwner = String(ownerAccountId || (chatServer && chatServer.ownerAccountId) || "").trim();
    if (!resolvedBus || typeof resolvedBus !== "object") {
      throw new Error("ChatBridge requires bus");
    }
    if (!resolvedOwner) {
      throw new Error("ChatBridge requires ownerAccountId");
    }
    this.#bus = resolvedBus;
    this.#ownerAccountId = resolvedOwner;
    this.#logger = logger || console;
  }

  get bus() {
    return this.#bus;
  }

  getSpec() {
    return CHAT_BRIDGE_SPEC;
  }

  async handle(client, method, paramsRecord) {
    const binding = CHAT_BRIDGE_METHOD_BINDINGS[String(method || "").trim()];
    if (!binding) {
      throw new Error("ChatBridge: unknown method '" + method + "'");
    }
    if (binding.namespace === "session" && binding.name === "hello") {
      client.authenticate({
        accountId: paramsRecord.accountId,
        deviceId: paramsRecord.deviceId,
      });
    }
    const result = await this.#bus.call(binding.namespace, binding.name, paramsRecord);
    if (result instanceof binding.result) {
      return result;
    }
    return new binding.result(result);
  }
}
