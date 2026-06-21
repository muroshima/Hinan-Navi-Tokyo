"use client";

import { useEffect, useState } from "react";

// Service Worker登録とオフライン状態の表示（PWA・圏外対応）
export default function PWA() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // 開発環境ではSWを登録しない（HMR/キャッシュで表示が不安定になるため本番のみ）
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* 登録失敗してもアプリは通常動作 */
      });
    }
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 bg-amber-500 px-3 py-1.5 text-center text-xs font-bold text-white shadow"
    >
      📡 オフラインです — キャッシュ済みの避難所データで検索できます（AI抽出は語句一致・地図タイルは表示されない場合あり）
    </div>
  );
}
