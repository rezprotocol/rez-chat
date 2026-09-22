export class MobileStartupErrorView {
  static install() {
    globalThis.__REZ_MOBILE__ = true;
    const show = (event) => {
      if (globalThis.__REZ_MOBILE_READY__ === true) return;
      const error = event.reason || event.error || new Error(event.message || "Startup failed");
      const render = () => {
        const root = document.getElementById("app");
        if (!root) return;
        const panel = document.createElement("main");
        panel.style.cssText = "padding:calc(env(safe-area-inset-top) + 32px) 24px;color:#eef2f6;font:17px system-ui;line-height:1.5";
        const title = document.createElement("h1"); title.textContent = "Rez Chat could not start";
        const detail = document.createElement("p"); detail.textContent = String(error.message || error);
        const retry = document.createElement("button"); retry.textContent = "Try again";
        retry.addEventListener("click", () => location.reload());
        panel.append(title, detail, retry); root.replaceChildren(panel);
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
      else render();
    };
    globalThis.addEventListener("error", show);
    globalThis.addEventListener("unhandledrejection", show);
  }
}
