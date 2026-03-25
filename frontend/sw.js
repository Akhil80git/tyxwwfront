// ═══════════════════════════════════════════════════════════════
//  MCQ Quiz Portal — Service Worker  v6.0
//  Full offline support + Install-time data prefetch
// ═══════════════════════════════════════════════════════════════

const CACHE_STATIC = "mcq-static-v6.0";
const CACHE_API    = "mcq-api-v6.0";

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon512.png",
];

// Ye APIs cache hongi (stale-while-revalidate)
const API_CACHE_PATTERNS = [
  "/api/public/subjects",
  "/api/public/topics/",
  "/api/public/quiz/",
  "/api/public/news-quiz",
  "/api/public/news-articles",
  "/api/news",
  "/api/notifications",
];

// Ye kabhi cache nahi honge (live AI only)
const NEVER_CACHE = [
  "/api/public/short-explain",
  "/api/public/chat",
  "/api/results/save",
];

// ══════════════════════════════════════════════════════════════
//  INSTALL
//  Shell assets cache karo — data prefetch client side hoga
// ══════════════════════════════════════════════════════════════
self.addEventListener("install", e => {
  console.log("[SW v6.0] Installing...");
  e.waitUntil(
    caches.open(CACHE_STATIC).then(cache =>
      Promise.allSettled(
        SHELL_ASSETS.map(url =>
          fetch(url, { cache: "no-store" })
            .then(res => { if (res.ok) return cache.put(url, res); })
            .catch(err => console.warn("[SW] Cache miss:", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

// ══════════════════════════════════════════════════════════════
//  ACTIVATE — Purane caches delete karo
// ══════════════════════════════════════════════════════════════
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => {
            console.log("[SW] Deleting old cache:", k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ══════════════════════════════════════════════════════════════
//  FETCH
// ══════════════════════════════════════════════════════════════
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Socket.io — never intercept
  if (url.pathname.startsWith("/socket.io")) return;

  // AI endpoints — network only, offline pe graceful error
  const isNeverCache = NEVER_CACHE.some(p => url.pathname.includes(p));
  if (isNeverCache) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(
          JSON.stringify({ error: "offline", text: "⚠️ AI explain ke liye internet chahiye.", usedTavily: false }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    return;
  }

  // POST/PUT/DELETE — network only (results save etc.)
  if (e.request.method !== "GET") {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    return;
  }

  // API routes — stale-while-revalidate (SW cache level)
  const isApiRoute = API_CACHE_PATTERNS.some(p => url.pathname.includes(p));
  if (isApiRoute) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_API));
    return;
  }

  // HTML shell — cache first, background update
  if (
    url.pathname === "/" ||
    url.pathname.endsWith("index.html") ||
    url.pathname.endsWith(".html")
  ) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request, { cache: "no-store" })
          .then(res => {
            if (res && res.ok) {
              caches.open(CACHE_STATIC).then(c => c.put(e.request, res.clone()));
            }
            return res;
          }).catch(() => null);

        return cached || fetchPromise || new Response(
          "<h1>Offline</h1><p>Internet check karo aur dobara try karo.</p>",
          { headers: { "Content-Type": "text/html" } }
        );
      })
    );
    return;
  }

  // Static assets — cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== "opaque") {
          caches.open(CACHE_STATIC).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => null);
    })
  );
});

// ══════════════════════════════════════════════════════════════
//  STALE WHILE REVALIDATE
// ══════════════════════════════════════════════════════════════
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request, { cache: "no-store" })
    .then(async res => {
      if (res && res.status === 200) {
        await cache.put(request, res.clone());
        // Client ko notify karo — fresh data available
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach(c => c.postMessage({ type: "SW_DATA_UPDATED", url: request.url }));
      }
      return res;
    })
    .catch(() => null);

  // Cached data turant do, background mein update hoga
  if (cached) return cached;

  const networkRes = await networkFetch;
  if (networkRes) return networkRes;

  return new Response(
    JSON.stringify({ error: "offline", cached: false }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

// ══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════
self.addEventListener("message", e => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (e.data?.type === "IDB_READY") {
    console.log("[SW] IDB ready, subjects:", e.data.subjectCount);
  }
  // Client se prefetch complete signal
  if (e.data?.type === "PREFETCH_DONE") {
    console.log("[SW] Prefetch complete signal received from client");
  }
});
