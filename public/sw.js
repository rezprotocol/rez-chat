const CACHE_NAME = "rez-chat-shell-v1";
const SHELL_KEY = "/__rez_chat_shell__";
const NETWORK_ONLY_PATHS = Object.freeze(["/ws", "/config", "/health", "/ready"]);

function isNetworkOnly(url) {
  return NETWORK_ONLY_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(path + "/"));
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isNetworkOnly(url)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(SHELL_KEY, response.clone());
        return response;
      } catch (err) {
        const cached = await cache.match(SHELL_KEY);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
