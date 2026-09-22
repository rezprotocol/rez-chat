import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { MobileHostRequestV1 } from "../../src/mobile/MobileHostRecords.js";

// Test transport to the compiled headless native host. The production host
// receives exactly the same request records through its native UI channel.
export class NativeTestApplication {
  #process;
  #label;
  #sequence = 0;
  #pending = new Map();
  #events = [];
  constructor(binary, bundle, directory, label, diagnostics) {
    this.#label = label;
    this.#process = spawn(binary, [bundle], { env: { ...process.env, REZ_NATIVE_PROBE_STORE: directory, REZ_NATIVE_PROBE_SERVE: "1" }, stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        if (response.level === "error" || response.level === "warn") diagnostics.push(label + ": " + response.message);
        if (response.event) this.#events.push(response);
        const callback = this.#pending.get(response.id);
        if (callback) callback(null, response);
      } catch (error) { this.#rejectPending(error); }
    });
    this.#process.once("error", (error) => this.#rejectPending(error));
    this.#process.once("exit", (code, signal) => this.#rejectPending(new Error("Native host exited: " + (signal || code))));
  }
  get process() { return this.#process; }
  get events() { return this.#events.slice(); }
  #rejectPending(error) { for (const callback of this.#pending.values()) callback(error); }
  async call(operation, params = {}) {
    const id = this.#label + ":" + (++this.#sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(operation + " timed out")); }, 210_000);
      this.#pending.set(id, (error, response) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (error) reject(error);
        else if (response.ok) resolve(JSON.parse(response.resultJson));
        else reject(new Error(operation + ": " + response.error));
      });
      this.#process.stdin.write(JSON.stringify(new MobileHostRequestV1({ id, operation, paramsJson: JSON.stringify(params) }).toJSON()) + "\n");
    });
  }
  async stop() {
    if (this.#process.exitCode !== null || this.#process.signalCode !== null) return;
    const exited = once(this.#process, "exit");
    this.#process.stdin.end();
    await exited;
  }
}
