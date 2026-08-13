import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";

function rezPwaIcons() {
  return {
    name: "rez-pwa-icons",
    async generateBundle() {
      const iconRoot = new URL("../rez-ui/branding/filled-silhouette/", import.meta.url);
      this.emitFile({
        type: "asset",
        fileName: "icons/rez-chat-256.png",
        source: await readFile(new URL("rez-icon-mark-notification.png", iconRoot)),
      });
      this.emitFile({
        type: "asset",
        fileName: "icons/rez-chat-1024.png",
        source: await readFile(new URL("rez-icon-full-transparent-filled.png", iconRoot)),
      });
    },
  };
}

export default defineConfig({
  plugins: [rezPwaIcons()],
  build: {
    outDir: "artifacts/rez-chat",
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    dedupe: ["@rezprotocol/core", "@rezprotocol/sdk", "@rezprotocol/ui"],
  },
  optimizeDeps: {
    include: ["@rezprotocol/core", "@rezprotocol/sdk", "@rezprotocol/ui"],
  },
});
