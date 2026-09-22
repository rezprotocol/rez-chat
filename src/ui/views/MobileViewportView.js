// UI-only geometry. The native execution engine never observes the keyboard
// or viewport and does not depend on this view remaining alive.
export class MobileViewportView {
  static install() {
    document.documentElement.classList.add("rez-mobile");
    const viewport = globalThis.visualViewport;
    const resize = () => {
      const height = viewport ? viewport.height : globalThis.innerHeight;
      document.documentElement.style.setProperty("--rez-mobile-height", Math.round(height) + "px");
      document.documentElement.style.setProperty("--rez-mobile-top", Math.round(viewport ? viewport.offsetTop : 0) + "px");
    };
    resize();
    globalThis.addEventListener("resize", resize);
    if (viewport) {
      viewport.addEventListener("resize", resize);
      viewport.addEventListener("scroll", resize);
    }
  }
}
