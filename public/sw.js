// QA Mini PWA service worker
// 策略：
//  - /api/*（含 SSE /api/events）：永远直连网络，绝不缓存（问答流必须实时）
//  - 页面导航：网络优先，离线回退到缓存首页
//  - 同源静态资源（app.js/style.css/icons）：缓存优先 + 后台更新（SWR 式回填）
// 静态资源有更新时，递增 CACHE 版本号并重新部署即可
const CACHE = "qa-mini-v11";
const SHELL = [
  "/",
  "/app.js",
  "/style.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;      // 跨域：交给浏览器
  if (event.request.method !== "GET") return;            // 只处理 GET
  if (url.pathname.startsWith("/api/")) return;          // API 与 SSE：直通网络

  const isStatic = url.pathname === "/app.js" || url.pathname === "/style.css"
    || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest";
  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        const net = fetch(event.request)
          .then((resp) => {
            if (resp && resp.status === 200) {
              const clone = resp.clone();
              caches.open(CACHE).then((c) => c.put(event.request, clone));
            }
            return resp;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // 页面导航：网络优先，离线回退缓存首页
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match("/"))
    );
  }
});
