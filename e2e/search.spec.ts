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
  // 検索成功は、畳みの外に常時出る1位カードのルートリンクで判定する。
  // 「他の候補」は候補が2件以上のときだけ描画されるので判定には使わない(#118)
  await expect(page.getByRole("link", { name: "ルート" }).first()).toBeVisible({ timeout: 15_000 });
});

// 地震ユースケース(#106): 想定災害が地震のとき、地域危険度・想定震度が現在地に当たり、
// 外出中なら帰宅困難者向けの一時滞在施設が先に提示される。
// LLM未設定でも語句一致fallback(地震/職場/電車)で属性が立つため外部依存なく通る。
test("地震×外出中で帰宅困難者モードと地震リスクが表示される", async ({ page }) => {
  await page.goto("/");

  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("職場にいるときに地震が起きたら。電車が止まって帰れない");
  await page.getByRole("button", { name: "避難所をさがす" }).click();

  // 外出中の属性チップが立つ
  await expect(page.getByText("外出中", { exact: true })).toBeVisible({ timeout: 15_000 });

  // 帰宅困難者モード: 一時滞在施設の案内が出る
  await expect(page.getByText("外出中に地震が起きたら")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("むやみに歩いて帰らないでください")).toBeVisible();

  // 現在地の地震リスク（同梱の地域危険度・想定震度から算出。既定の現在地=東京駅で必ず値が引ける）
  await expect(page.getByText("いまいる場所の地震リスク")).toBeVisible({ timeout: 15_000 });
});

// 言語セレクタは以前タイムラインの生成言語にしか効かず、選んでも画面が変わらなかった(#118)。
// 最初に触る画面のことばが切り替わることを固定する
test("言語を切り替えると画面のことばが変わる", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "避難所をさがす" })).toBeVisible();

  await page.selectOption("#lang", "en");
  await expect(page.getByRole("button", { name: "Find shelters" })).toBeVisible();

  await page.selectOption("#lang", "zh");
  await expect(page.getByRole("button", { name: "寻找避难所" })).toBeVisible();

  await page.selectOption("#lang", "ja-easy");
  await expect(page.getByRole("button", { name: "ひなんじょを さがす" })).toBeVisible();
});

// 例文はワンタップでそのまま検索まで走る（押しても入力されるだけでは、もう一手かかる）
test("例文を押すだけで結果まで出る", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "水害・車椅子" }).click();
  await expect(page.getByRole("link", { name: "ルート" }).first()).toBeVisible({ timeout: 20_000 });
  // 入力欄にも本文が入っている（押した内容が確認できる）
  await page.getByRole("button", { name: "条件を変えて探し直す" }).click();
  await expect(page.getByPlaceholder("例）雨の日、車椅子の母と避難したい")).toHaveValue(
    /車椅子の母と避難したい/
  );
});
