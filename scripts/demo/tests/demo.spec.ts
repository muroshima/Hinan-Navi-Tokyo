import { test, expect, type Page } from "@playwright/test";

// だれでも避難ナビ TOKYO ハッカソン提出用デモ動画の収録シナリオ（約62秒）。
// narration/demo.ja.json の cue タイミングに視覚を合わせる（各シーンの目標秒は untilT で固定）。
// 外部依存を避けるため triage は語句一致fallbackで成立、地図タイルのみネットワーク。
// シナリオ: ①課題 → ②自然文入力 → ③配慮属性抽出 → ④「行ける順」再ランキング
//          → ⑤なぜ1位か根拠＋点数内訳 → ⑥ハザード/PLATEAU重ね → ⑦まとめ

test("だれでも避難ナビ TOKYO デモ", async ({ page }) => {
  const t0 = Date.now();
  // 動画時間 sec の時点まで待つ（既に過ぎていれば待たない）。ナレーションと視覚を揃える基準。
  const untilT = async (sec: number) => {
    const remain = t0 + sec * 1000 - Date.now();
    if (remain > 0) await page.waitForTimeout(remain);
  };

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "だれでも避難ナビ TOKYO" })).toBeVisible();
  await expect(page.getByText("避難の最終判断は必ず自治体")).toBeVisible();

  // ── シーン①: 課題（cue0 0.5-9.5）。ホーム＋免責を見せ、例文チップにホバーで生命感を出す
  await untilT(4.5);
  await page.getByRole("button", { name: /雨の日、車椅子の母/ }).first().hover();
  await untilT(7.0);
  await page.getByRole("button", { name: /夜に、目の不自由な父/ }).first().hover();

  // ── シーン②: 自然文入力（cue1 9.5-16.8）
  const ta = page.getByPlaceholder("例）雨の日、車椅子の母と避難したい");
  await untilT(9.6);
  await ta.click();
  await ta.pressSequentially("雨の日、車椅子の母と避難したい。介助は私がします", { delay: 55 });
  await untilT(13.5);
  await page.getByRole("button", { name: "避難所をさがす" }).click();

  // 抽出された配慮属性チップ（fallbackでも 車椅子/介助者あり/雨・荒天 が立つ）
  await expect(page.getByText("車椅子", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("介助者あり", { exact: true })).toBeVisible();

  // ── シーン③: 配慮属性抽出（cue2 16.8-23）。チップ＋複合ニーズバナーを見せる（上部に表示）
  await untilT(17.0);
  await page.getByText("車椅子", { exact: true }).scrollIntoViewIfNeeded();

  // ── シーン④: 「行ける順」再ランキング（cue3 23.5-31.9）。1位カードと結果リストへスクロール
  await untilT(24.0);
  const why = page.getByText(/が1位/);
  await expect(why).toBeVisible({ timeout: 15_000 });
  await why.scrollIntoViewIfNeeded();
  await untilT(28.0);
  // 結果リストを少し送って「より近いのに見送った理由」と順位を見せる
  await scrollAside(page, 260);

  // ── シーン⑤: なぜ1位か根拠＋点数内訳（cue4 33.5-42.5）
  await untilT(33.6);
  await why.scrollIntoViewIfNeeded();
  await untilT(37.0);
  // 1位カードの点数内訳（自動展開済み）を確実に画面内へ
  await page.getByText("点数内訳").first().scrollIntoViewIfNeeded();

  // ── シーン⑥: ハザード/PLATEAU 重ね（cue5 44-51.7）
  await untilT(44.2);
  await page.getByRole("button", { name: /洪水/ }).click(); // 洪水ハザードタイルを重ねる
  await page.mouse.move(900, 380);
  await untilT(47.5);
  await page.getByRole("button", { name: /建物3D/ }).click(); // PLATEAU建物3D（垂直避難・pitch傾斜）
  await page.mouse.move(880, 360);

  // ── シーン⑦: まとめ（cue6 54-61.6）。地図（ハザード＋3D建物）で余韻
  await untilT(55.0);
  await page.mouse.move(820, 420);
  await untilT(62.5); // 最終cue終端 + 余白まで dwell
});

// スクロール可能なサイドバー(aside)を dy px 下へスクロール
async function scrollAside(page: Page, dy: number) {
  await page.evaluate((d) => {
    const aside = document.querySelector("aside");
    if (aside) aside.scrollBy({ top: d, behavior: "smooth" });
  }, dy);
}
