import type { NextConfig } from "next";

// セキュリティヘッダ(#66)。全パスに付与。
// CSPの方針:
//  - script-src は 'self' + 'unsafe-inline'（Next.jsのhydrationブートストラップにインラインscriptが要る。
//    nonce運用はNext16のproxy/middlewareが必要なためプロトタイプでは'unsafe-inline'。XSS自体は
//    全出力をescapeHtml済み・dangerouslySetInnerHTML不使用で塞いでいる）。'unsafe-eval'は付けない。
//  - MapLibreの地図タイル(OSM/国交省ハザード/AWS DEM/PLATEAU/glyphs)は多数のhttpsホストから取得するため、
//    img-src/connect-src は MapLibre が使う実タイルホストを列挙して最小化（XSS時のデータ送信先を限定）。
//    worker-src は Service Worker('self')と MapLibre の blob worker を許可。
//  - script-src-attr 'none' でインラインイベントハンドラ(onclick=等)を禁止（インラインscript実行は維持）。
//  - frame-ancestors 'none' でクリックジャッキング遮断（X-Frame-Options も併記）。
// MapLibre が参照する外部タイル/glyphs/ベクタのホスト（components/MapView.tsx と一致）
const TILE_HOSTS = [
  "https://tile.openstreetmap.org", // OSM ベース地図(raster)
  "https://disaportaldata.gsi.go.jp", // 国交省ハザード(raster)
  "https://s3.amazonaws.com", // AWS Terrarium DEM(raster)
  "https://demotiles.maplibre.org", // MapLibre glyphs(pbf)
  "https://indigo-lab.github.io", // PLATEAU 建物 MVT(pbf)
].join(" ");
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${TILE_HOSTS}`,
  `connect-src 'self' ${TILE_HOSTS}`,
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Permissions-Policy", value: "geolocation=(self), microphone=(self)" },
];

const nextConfig: NextConfig = {
  // Cloud Run向けに自己完結の standalone 出力（.next/standalone に server.js）
  output: "standalone",
  async headers() {
    return [
      {
        // 全パスにセキュリティヘッダを付与
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      {
        // Service Workerは常に最新を取得（キャッシュさせない）＋正しいMIME
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
