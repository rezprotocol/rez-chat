import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
let revision = 0;
const builds = ["aaaaaaaa", "bbbbbbbb", "cccccccc"];
const preview = { name: "browser-update-qa", configureServer(server) {
  server.middlewares.use((request, response, next) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/__qa_publish" && request.method === "POST") {
      revision = Math.min(revision + 1, builds.length - 1);
      response.end("Published " + builds[revision]);
      return;
    }
    if (/^\/assets\/update-[abc]{8}\.js$/.test(url.pathname)) {
      response.setHeader("Content-Type", "text/javascript");
      response.end('import "/test/support/browserUpdateUiFixture.js";');
      return;
    }
    if (url.pathname !== "/") return next();
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><html><head><title>Browser update verification</title></head><body class="bg-surface-dim text-on-surface p-8"><h1>Browser update verification</h1><p id="loaded"></p><p id="preserved"></p><div class="my-8 flex gap-4"><button id="publish">Publish next test build</button><button id="check">Reconnect and check</button><button id="stop">Stop monitor</button></div><div id="composer"></div><script type="module" src="/assets/update-' + builds[revision] + '.js"></script></body></html>');
  });
} };
const server = await createServer({ root, plugins: [preview], server: { host: "127.0.0.1", port: 5198, strictPort: true } });
await server.listen();
console.log("Browser update verification: http://127.0.0.1:5198/");
