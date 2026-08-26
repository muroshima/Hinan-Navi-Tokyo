import { defineConfig, devices } from "@playwright/test";

// e2e は本番相当の `next start` に対して実行する（要事前 `npm run build`）。
// CI では build → playwright test の順で走らせる（.github/workflows/ci.yml）。
// ローカルで開発サーバ(3000)を立てたままでも、本番相当のビルドに対して検査できるように
// ポートを切り替えられる。既定は 3000（開発サーバが居ればそれを再利用する）。
// `next start` に対して確かめたい時は E2E_PORT=3100 のように別ポートを渡す。
// ⚠️ reuseExistingServer は「そのポートで何か応答すれば」再利用する。自分で立てた
//    サーバが残っていると、ビルドし直しても古い内容のまま走る（実際に検証が
//    11分かかって1件しか通らない状態になった）。ビルドを変えたら立て直す
const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // 逐次で走らせる。地図(MapLibre)の描画と 2MB のハザードデータ読み込みが重く、
  // 並列にすると CPU を奪い合って検索の応答やドラッグの反映が間に合わず、
  // 毎回ちがう1件がランダムに落ちる。実測でも逐次の方が速く(約35秒)、安定する
  workers: 1,
  retries: 1,
  // ドラッグ系は段送りのアニメーション(260ms)と待ちが積み上がる。
  // CI の runner は遅く、既定の30秒では 1テストが最後まで走りきらない
  timeout: 60_000,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // 注: next.config は output:"standalone"(Cloud Run用)のため `next start` は警告を出すが、
    // ビルド済みアプリ(クライアントJS含む)は正しく配信されe2eは通る。本番の配信は
    // Docker の `node server.js`(standalone)で行う。e2eは事前の `npm run build` が必要。
    command: "npm run start",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    // 外部の PORT env が設定されていても baseURL(3000) と待受ポートを一致させる
    env: { PORT: String(PORT) },
  },
});
