import { ChatBus } from "../../src/ui/root/ChatBus.js";
import { ThreadPanelView } from "../../src/ui/views/ThreadPanelView.js";
import { ChatThread, ChatMessage } from "../../src/records/index.js";
import "../../src/styles/fonts.css";
import "../../src/styles/tailwind.css";
import "@rezprotocol/ui/framework/theme.css";
import "../../src/ui/styles.css";

const bus = new ChatBus();
for (const [key, name] of [
  ["session", "Session"], ["uiState", "UiState"], ["threads", "Thread"],
  ["messages", "Message"], ["contacts", "Contact"], ["groups", "Group"],
  ["channels", "Channel"], ["connection", "Connection"], ["notices", "Notices"],
]) {
  const module = await import(/* @vite-ignore */ "../../src/ui/stores/" + name + "Store.js");
  bus.stores[key] = new module[name + "Store"]({ bus });
}
bus.queries = {};
for (const [key, name] of [["threads", "Thread"], ["messages", "Message"], ["contacts", "Contact"], ["groups", "Group"], ["channels", "Channel"]]) {
  const module = await import(/* @vite-ignore */ "../../src/ui/queries/" + name + "Queries.js");
  bus.queries[key] = new module[name + "Queries"]({ stores: bus.stores });
}
bus.stores.session.setUnlocked({ accountId: "rez:acct:alice", ownerAccountId: "rez:acct:alice", deviceId: "dev:alice" });
for (const threadId of ["th_group", "th_other"]) {
  bus.stores.threads.upsertThread(new ChatThread({ threadId, threadType: "group", groupId: "g_qa", title: "Attachment checks" }));
}
bus.stores.uiState.setSelectedThreadId("th_group");
bus.services.messages = { getReplyDraft() { return ""; } };
let sends = 0;
let lastFileName = "";
bus.registerFunction({ namespace: "messages", name: "sendImage", fn: async (params) => {
  sends++;
  lastFileName = params.fileName;
} });
bus.registerFunction({ namespace: "messages", name: "send", fn: async () => { sends++; } });
bus.registerFunction({ namespace: "groups", name: "ensureMembers", fn: async () => [] });
const panel = new ThreadPanelView({ bus });
panel.mount(document.getElementById("panel"));
const result = document.getElementById("result");

function check(condition, message) {
  if (!condition) throw new Error(message);
  result.textContent += "PASS: " + message + "\n";
}
function drop(files, target = document.getElementById("outside")) {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  for (const type of ["dragenter", "dragover", "drop"]) {
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(event);
    check(event.defaultPrevented, type + " prevents browser file navigation");
  }
}
async function settled() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function waitForAttachment() {
  const deadline = performance.now() + 5000;
  while (!document.querySelector('[title="Remove attachment"]')) {
    if (performance.now() > deadline) throw new Error("Attachment preview did not appear");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  check(getComputedStyle(document.querySelector('[data-testid="thread-panel.drop-overlay"]')).display === "none", "preview loads application styles and hides the drop overlay");
  const file = new File(["attachment bytes"], "notes.txt", { type: "text/plain" });
  const inputClick = HTMLInputElement.prototype.click;
  let pickedInput = null;
  try {
    HTMLInputElement.prototype.click = function() { pickedInput = this; };
    document.querySelector('[aria-label="Attach file"]').click();
  } finally { HTMLInputElement.prototype.click = inputClick; }
  check(pickedInput && pickedInput.isConnected, "file picker keeps its input mounted until selection");
  const selection = new DataTransfer();
  selection.items.add(file);
  pickedInput.files = selection.files;
  pickedInput.dispatchEvent(new Event("change"));
  await waitForAttachment();
  check(!pickedInput.isConnected && document.querySelector('[title="Remove attachment"]'), "picker selection stages the file and cleans up its input");
  document.querySelector('[title="Remove attachment"]').click();
  try {
    HTMLInputElement.prototype.click = function() { pickedInput = this; };
    document.querySelector('[aria-label="Attach file"]').click();
  } finally { HTMLInputElement.prototype.click = inputClick; }
  pickedInput.dispatchEvent(new Event("cancel"));
  check(!pickedInput.isConnected, "cancelling the picker cleans up its input");
  drop([file]);
  await waitForAttachment();
  check(document.querySelector('[title="Remove attachment"]') !== null, "sidebar/window drop stages a file");
  document.querySelector('[data-testid="composer.send"]').click();
  await settled();
  check(sends === 1 && lastFileName === "notes.txt", "Send forwards exactly one staged file");
  drop([file, file]);
  check(document.querySelector('[data-testid="composer.error"]').textContent === "Attach one file at a time.", "multiple files are explicitly rejected");
  check(document.querySelector('[title="Remove attachment"]') === null, "multiple-file rejection stages nothing");
  drop([new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.bin")]);
  check(document.querySelector('[data-testid="composer.error"]').textContent.includes("File too large"), "10 MiB file limit is enforced");
  drop([file]);
  bus.stores.uiState.setSelectedThreadId("th_other");
  await settled();
  check(document.querySelector('[title="Remove attachment"]') === null, "late file read cannot attach to another conversation");
  bus.stores.threads.patchThread("th_other", { sendAllowed: false });
  drop([file]);
  await settled();
  check(document.querySelector('[title="Remove attachment"]') === null, "disabled conversation rejects drops");
  check(document.querySelector('[data-testid="thread-panel.drop-overlay"]').classList.contains("hidden"), "drop overlay clears");
  bus.stores.threads.patchThread("th_other", { sendAllowed: true });
  bus.stores.messages.upsertMessage("th_other", new ChatMessage({ threadId: "th_other", messageId: "m_qa", senderAccountId: "rez:acct:alice", text: "A group member confirmed receipt", status: "delivered" }));
  await settled();
  const status = document.querySelector('[data-testid="message.status"]');
  check(status && status.title === "Delivered to at least one group member.", "group Delivered explains first-member confirmation");
  panel.unmount();
  const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
  document.getElementById("outside").dispatchEvent(event);
  check(!event.defaultPrevented, "unmount removes window drop handlers");
  panel.mount(document.getElementById("panel"));
  result.dataset.status = "passed";
  result.textContent += "ALL CHECKS PASSED";
} catch (error) {
  result.dataset.status = "failed";
  result.textContent += "FAIL: " + error.stack;
}
