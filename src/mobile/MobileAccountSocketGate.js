// Visibility gate for explicitly account-bearing enrollment transports.
// Portable sockets never enter this owner. A background signal closes these
// sockets immediately, even while enrollment is awaiting a remote approval.
export class MobileAccountSocketGate {
  #factory;
  #foreground = false;
  #sockets = new Set();
  constructor(factory) {
    if (typeof factory !== "function") throw new Error("Account socket factory required");
    this.#factory = factory;
  }
  foreground() { this.#foreground = true; }
  open(url) {
    if (!this.#foreground) throw new Error("Account enrollment requires Rez Chat in the foreground");
    const socket = this.#factory(url);
    this.#sockets.add(socket);
    socket.addEventListener("close", () => this.#sockets.delete(socket));
    return socket;
  }
  background() {
    this.#foreground = false;
    let failure = null;
    for (const socket of this.#sockets) {
      try { socket.close(); } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  }
}
