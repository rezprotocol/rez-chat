// The synthetic, UI-only "System" thread surfaces runtime notices (e.g. a
// quarantined mailbox deposit) to the user so nothing is ever silently dropped.
// It is NOT a real conversation: there is no server-side thread, no peer, and no
// MessageStore rows. It is non-deletable and read-only (a reply has nowhere to
// go); archive is a purely-local UI status. Notices live in NoticesStore and are
// rendered as failed-message bubbles by SystemNoticeRowView.
export const SYSTEM_NOTICES_THREAD_ID = "system:notices";

export function isSystemNoticesThreadId(threadId) {
  return String(threadId == null ? "" : threadId).trim() === SYSTEM_NOTICES_THREAD_ID;
}

// Friendly, human description of why a deposit was dropped. Shared by the row
// view (hover tooltip) and the service (thread-list preview). The quarantine
// event is undecryptable, so the only facts available are the bound that fired
// (attempts vs age) and its magnitude.
export function noticeReasonText(event) {
  const reason = event && typeof event.reason === "string" ? event.reason.trim() : "";
  const attempts = event && Number.isFinite(event.attempts) ? Number(event.attempts) : 0;
  const ageMs = event && Number.isFinite(event.ageMs) ? Number(event.ageMs) : 0;
  if (reason === "age") {
    const mins = Math.max(1, Math.round(ageMs / 60000));
    return "dropped after " + mins + " min undelivered";
  }
  if (attempts > 0) {
    return "dropped after " + attempts + " failed delivery attempts";
  }
  return "dropped after repeated delivery failures";
}
