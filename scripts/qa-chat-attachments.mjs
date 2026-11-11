import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const preview = { name: "chat-attachment-qa", configureServer(server) {
  server.middlewares.use((request, response, next) => {
    if (request.url !== "/__chat_attachment_qa") return next();
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><html><head><title>Attachment UI checks</title></head><body class="bg-surface-dim text-on-surface"><aside id="outside">Attachment UI checks</aside><section id="panel" class="flex flex-col h-[60vh]"></section><pre id="result"></pre><script type="module" src="/test/support/chatAttachmentUiFixture.js"></script></body></html>');
  });
} };
const server = await createServer({ root, plugins: [preview], server: { host: "127.0.0.1", port: 5188, strictPort: true } });
await server.listen();
console.log("Attachment UI checks: http://127.0.0.1:5188/__chat_attachment_qa");
