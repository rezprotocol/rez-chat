export class FakeRuntimeClient {
  constructor({ accountId = "rez:acct:test", localInboxId = "inbox:test:local", threads = [] } = {}) {
    this._sessionInfo = {
      accountId: String(accountId || ""),
      localInboxId: String(localInboxId || ""),
      capabilities: {
        localInboxId: String(localInboxId || ""),
      },
    };
    this._threads = Array.isArray(threads) ? [...threads] : [];
    this._handlers = new Map();
    this.requests = [];
  }

  async connect() {}

  async disconnect() {}

  async close() {}

  getSessionInfo() {
    return { ...this._sessionInfo };
  }

  on(eventName, handler) {
    const key = String(eventName || "");
    const set = this._handlers.get(key) || new Set();
    set.add(handler);
    this._handlers.set(key, set);
    return () => {
      const current = this._handlers.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this._handlers.delete(key);
    };
  }

  onState(handler) {
    return this.on("sdk.session.stateChanged", handler);
  }

  onMessage(handler) {
    return this.on("evt.message.upsert", handler);
  }

  onReceipt(handler) {
    return this.on("evt.receipt", handler);
  }

  onThreadUpsert(handler) {
    return this.on("evt.thread.upsert", handler);
  }

  onEvent(eventType, handler) {
    return this.on(`event:${String(eventType || "")}`, handler);
  }

  emit(eventName, payload = {}) {
    const key = String(eventName || "");
    const frame = payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "body")
      ? payload
      : { t: key, body: payload };

    const direct = this._handlers.get(key);
    if (direct) {
      for (const fn of [...direct]) fn(frame);
    }

    const eventHandlers = this._handlers.get(`event:${key}`);
    if (eventHandlers) {
      for (const fn of [...eventHandlers]) fn(frame);
    }
  }

  /**
   * Emit a Record-like object to onEvent handlers (no frame wrapping).
   * Matches real SDK behavior where onEvent receives rehydrated Records.
   */
  emitRecord(eventName, record = {}) {
    const key = String(eventName || "");
    const eventHandlers = this._handlers.get(`event:${key}`);
    if (eventHandlers) {
      for (const fn of [...eventHandlers]) fn(record);
    }
  }

  async listThreads() {
    return {
      threads: [...this._threads],
    };
  }

  async getThread({ threadId } = {}) {
    const id = String(threadId || "");
    const thread = this._threads.find((row) => String(row?.threadId || "") === id) || {
      threadId: id,
      title: "Thread",
    };
    return {
      thread,
      messages: {
        cursor: null,
        messages: [],
      },
    };
  }

  async listContacts() {
    return { body: { items: [] } };
  }

  async listInvites() {
    return { body: { items: [] } };
  }

  async getMeshStatus() {
    return { body: { mesh: { enabled: false, peers: [] } } };
  }

  async markThreadRead() {
    return { body: {} };
  }

  async setThreadState({ threadId, visibilityState = undefined, accessState = undefined } = {}) {
    const id = String(threadId || "");
    const index = this._threads.findIndex((row) => String(row?.threadId || "") === id);
    if (index < 0) return { thread: null };
    const current = this._threads[index];
    const next = {
      ...current,
      ...(visibilityState !== undefined ? { visibilityState } : {}),
      ...(accessState !== undefined ? { accessState } : {}),
    };
    this._threads[index] = next;
    return { thread: { ...next } };
  }

  async listThreadMessages() {
    return { items: [], nextBefore: null };
  }

  async sendRequest({ type, body = {} } = {}) {
    const reqType = String(type || "");
    this.requests.push({ type: reqType, body });
    return { type: `${reqType}.res`, body: {} };
  }
}
