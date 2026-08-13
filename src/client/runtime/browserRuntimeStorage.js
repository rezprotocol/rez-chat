export function browserChatRuntimeDbName(accountId) {
  const owner = String(accountId || "").trim();
  if (!owner) throw new Error("browserChatRuntimeDbName requires accountId");
  return "rez-chat-runtime:" + owner;
}
