import { test, expect, devices } from "@playwright/test";

// スマホUI(#107)のe2e: 地図が全画面で、操作パネルがボトムシートとして機能することを確かめる。
// 実機と同じ条件で見るため、このファイルだけ iPhone 相当のエミュレーションを使う。
// defaultBrowserType は外す。付いたままだと chromium プロジェクトで WebKit を起動しようとして
// 失敗し、CI に WebKit のインストールまで要求してしまう（画面サイズとタッチの再現には不要）。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iPhone } = devices["iPhone 13"];
test.use(iPhone);

test("ボトムシートが3段階で開閉し、検索後は避難先が先に見える", async ({ page }) => {
  await page.goto("/");

  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await expect(handle).toBeVisible();

  // 畳んだ状態(peek)でも、入力欄と検索ボタンには手が届く
  const input = page.getByPlaceholder("例）雨の日、車椅子の母と避難したい");
  const searchButton = page.getByRole("button", { name: "避難所をさがす" });
  await expect(input).toBeVisible();
  await expect(searchButton).toBeVisible();

  await input.fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await searchButton.click();

  // 検索後は入力欄が畳まれ、結果が先頭に来る（狭い画面で避難先までスクロールさせない）
  await expect(page.getByRole("button", { name: "条件を変えて探し直す" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(input).toBeHidden();
  await expect(page.getByText("が1位？")).toBeVisible({ timeout: 15_000 });

  // 畳んだ入力欄は開き直せる
  await page.getByRole("button", { name: "条件を変えて探し直す" }).click();
  await expect(input).toBeVisible();

  // 検索が終わるとシートは自動で中段まで上がっている（畳んだままだと結果に気づけない）
  await expect(handle).toHaveAccessibleName(/現在: 中/);
  // つまみをタップすると最大まで開く
  await handle.click();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
});

// pointerup のあとに click も発火するため、両方でスナップを変えると必ず1段ずれる。
// ドラッグした先にそのまま着地することを固定する（Copilot 指摘で見つかった不具合の回帰防止）
test("つまみをドラッグした先にそのまま着地する", async ({ page }) => {
  await page.goto("/");
  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await expect(handle).toHaveAccessibleName(/現在: 小/);

  // つまみの中心を掴んで dy ピクセルだけ動かす（相対移動。閾値の判定と条件を揃える）
  const dragBy = async (dy: number) => {
    const box = (await handle.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + dy, { steps: 15 });
    await page.mouse.up();
  };

  // 大きく上へ引き上げれば最大まで開く（1段戻ってはいけない）
  await dragBy(-420);
  await expect(handle).toHaveAccessibleName(/現在: 大/);

  // 大きく下げれば畳まれる
  await dragBy(420);
  await expect(handle).toHaveAccessibleName(/現在: 小/);

  // ほとんど動かさない操作はタップとして扱い、次の段階へ進む
  await dragBy(3);
  await expect(handle).toHaveAccessibleName(/現在: 中/);
});

test("結果カードから地図の該当地点へ寄せられる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("高齢の祖父と一緒。地震のとき逃げられる所を教えて");
  await page.getByRole("button", { name: "避難所をさがす" }).click();
  await expect(page.getByText("が1位？")).toBeVisible({ timeout: 15_000 });

  // カードの「地図」ボタンでシートが畳まれ、地図が見える状態になる
  const mapButton = page.getByRole("button", { name: /を地図で見る$/ }).first();
  await mapButton.click();
  await expect(page.getByRole("button", { name: /情報パネルの高さを変える（現在: 小）/ })).toBeVisible();
});

test("指で操作する画面では主要な操作要素が44px以上ある", async ({ page }) => {
  await page.goto("/");
  // 手が震える状況でも押し間違えないだけの大きさがあること
  const tooSmall = await page.evaluate(() => {
    const targets = document.querySelectorAll(
      "aside button, aside select, aside input, aside [role=button]"
    );
    return [...targets]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.height < 44;
      })
      .map((el) => `${el.tagName}: ${(el.textContent || "").trim().slice(0, 20)}`);
  });
  expect(tooSmall).toEqual([]);
});
