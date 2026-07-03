import type { NextConfig } from "next";
import { MAP_CONNECT_HOSTS } from "./lib/mapHosts";

// セキュリティヘッダ(#66)。全パスに付与。
// CSPの方針:
//  - script-src は 'self' + 'unsafe-inline'（Next.jsのhydrationブートストラップにインラインscriptが要る。
//    nonce運用はNext16のproxy/middlewareが必要なためプロトタイプでは'unsafe-inline'。'unsafe-eval'は付けない）。
//    XSS対策自体は、データ由来文字列を差し込む MapLibre ポップアップで escapeHtml を適用し、
//    dangerouslySetInnerHTML を使わない方針で担保（アプリ全体を網羅する保証ではなく、既知の差込点を塞ぐ）。
//  - script-src-attr 'none' でインラインイベントハンドラ(onclick=等)を禁止（インラインscript実行は維持）。
//  - MapLibre GL v5 はラスタ/ベクタ/glyphs を全て Fetch API で取得する(実測確認)ため、外部タイルホストは
//    connect-src に限定列挙する。img-src は data:/blob: のみ(タイルは fetch→canvas 描画で<img>化しない)。
//    ホスト定義は lib/mapHosts.ts に集約し MapView と共有(片側更新でのCSP違反を防止)。
//  - worker-src は Service Worker('self')と MapLibre の blob worker を許可。
//  - frame-ancestors 'none' でクリックジャッキング遮断（X-Frame-Options も併記）。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${MAP_CONNECT_HOSTS.join(" ")}`,
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
