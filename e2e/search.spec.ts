import { test, expect } from "@playwright/test";

// 中核フローのe2e: 自然文で相談 → 配慮属性の抽出 → 避難所ランキング表示。
// LLM(Vertex)未設定のローカル/CIでも、語句一致fallback＋同梱geojsonで完結し外部依存なく通る。
// (地図タイル/OSRM/Nominatimは外部依存かつ描画/経路用なので、判定はサイドバー側で行う)
test("自然文で検索すると配慮属性が抽出され避難所がランキング表示される", async ({ page }) => {
  await page.goto("/");

  // 初期表示
  await expect(page.getByRole("heading", { name: "だれでも避難ナビ TOKYO" })).toBeVisible();
  // 常時表示の免責が出ている
  await expect(page.getByText("避難の最終判断は必ず自治体")).toBeVisible();

  // 自然文を入力して検索（地名を含めず、外部ジオコーディングに依存しない文にする）
  await page.getByPlaceholder("例）雨の日、車椅子の母と避難したい").fill("雨の日、車椅子の母と避難したい。介助は私がします");
  await page.getByRole("button", { name: "避難所をさがす" }).click();

  // 抽出された配慮属性チップ（fallback抽出でも車椅子/介助者あり/雨・荒天が立つ）
  await expect(page.getByText("車椅子", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("介助者あり", { exact: true })).toBeVisible();

  // ランキング結果（1位の根拠パネル）が表示される
  await expect(page.getByText("が1位？")).toBeVisible({ timeout: 15_000 });
});
