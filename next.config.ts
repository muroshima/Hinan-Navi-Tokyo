import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run向けに自己完結の standalone 出力（.next/standalone に server.js）
  output: "standalone",
  async headers() {
    return [
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
