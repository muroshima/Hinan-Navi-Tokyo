// だれでも避難ナビ TOKYO の Service Worker（オフライン対応）
// 方針:
//  - 同一オリジンのみ扱う（外部タイル/ジオコーディング/LLM等は素通し＝オフライン時は自然に失敗）
//  - アプリシェル(/)と避難所データ(/data/*)を precache し、圏外でも検索できるようにする
//  - /api/* はサーバー必須のため network-only（キャッシュしない）
const VERSION = "v1";
const CACHE = `hinan-navi-${VERSION}`;
const PRECACHE = [
  "/",
  "/data/evacuation.geojson",
  "/data/toilets.geojson",
  "/data/metadata.json",
  "/manifest.webmanifest",
  "/icon-192x192.png",
  "/icon-512x512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // 一部が404でも全体を失敗させない（個別にput）
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* 取得失敗はスキップ */
          }
        })
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 同一オリジン以外（地図タイル・OSRM・Nominatim等）は介入しない
  if (url.origin !== self.location.origin) return;
  // APIはサーバー必須。キャッシュせずネットワークに任せる
  if (url.pathname.startsWith("/api/")) return;

  // 画面遷移: network-first、失敗時はキャッシュのアプリシェル
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("/")) || Response.error();
        }
      })()
    );
    return;
  }

  // 静的アセット・データ: stale-while-revalidate（即キャッシュ返却＋裏で更新）
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })()
  );
});
