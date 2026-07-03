import { defineConfig, devices } from "@playwright/test";
import path from "path";

// デモ動画収録専用の Playwright config（e2e の playwright.config.ts とは別物）。
// - video: "on" で全テストを録画（1280x720）
// - slowMo で機械的な操作感をやわらげる
// - webServer は本番相当の `next start`（dev の Strict Mode 二重mountでReact stateが
//   飛ぶ罠を回避。要事前 `npm run build`）
// 収録: npx playwright test --config scripts/demo/playwright.config.ts
const ROOT = path.resolve(__dirname, "../..");
const PORT = 3000;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180 * 1000,
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    launchOptions: { slowMo: 60 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  outputDir: path.resolve(__dirname, "output/raw"),
  webServer: {
    command: "npm run start",
    cwd: ROOT,
    url: baseURL,
    timeout: 180 * 1000,
    reuseExistingServer: true,
    env: { PORT: String(PORT) },
  },
});
