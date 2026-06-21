import type { MetadataRoute } from "next";

// PWAマニフェスト（ホーム画面インストール・スタンドアロン表示）
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "だれでも避難ナビ TOKYO",
    short_name: "避難ナビ",
    description: "ことばで状況を伝えると、要配慮者が本当に行ける避難所を探す防災ナビ",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2563eb",
    lang: "ja",
    icons: [
      { src: "/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
