import { defineConfig } from "vite";

export default defineConfig({
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
