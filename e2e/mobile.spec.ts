import { test, expect, devices } from "@playwright/test";

// スマホUI(#107)のe2e: 地図が全画面で、操作パネルがボトムシートとして機能することを確かめる。
// 実機と同じ条件で見るため、このファイルだけ iPhone 相当のエミュレーションを使う。
// defaultBrowserType は外す。付いたままだと chromium プロジェクトで WebKit を起動しようとして
// 失敗し、CI に WebKit のインストールまで要求してしまう（画面サイズとタッチの再現には不要）。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iPhone } = devices["iPhone 13"];
test.use(iPhone);

test("相談してから地図とシートが現れ、検索後は避難先が先に見える", async ({ page }) => {
  await page.goto("/");

  // 相談モード: 地図もシートのつまみも出さず、現在地と相談欄だけ(#118)
  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await expect(handle).toBeHidden();
  await expect(page.locator("main")).toHaveCount(0);

  const input = page.getByPlaceholder("例）雨の日、車椅子の母と避難したい");
  const searchButton = page.getByRole("button", { name: "避難所をさがす" });
  await expect(input).toBeVisible();
  await expect(searchButton).toBeVisible();

  await input.fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await searchButton.click();

  // 検索後に地図とシートが現れる
  await expect(page.locator("main")).toHaveCount(1, { timeout: 15_000 });
  await expect(handle).toBeVisible();

  // 検索後は入力欄が畳まれ、結果が先頭に来る（狭い画面で避難先までスクロールさせない）
  await expect(page.getByRole("button", { name: "条件を変えて探し直す" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(input).toBeHidden();
  await expect(page.getByRole("link", { name: "ルート" }).first()).toBeVisible({ timeout: 15_000 });

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
  // シートは検索後に現れるので、まず検索する(#118)
  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await page.getByRole("button", { name: "避難所をさがす" }).click();
  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await expect(handle).toBeVisible({ timeout: 15_000 });
  // 検索直後は中段。畳んでから開き具合を確かめる（各遷移を待ってから次を叩く）
  await expect(handle).toHaveAccessibleName(/現在: 中/);
  await handle.click();
  await expect(handle).toHaveAccessibleName(/現在: 大/);
  await handle.click();
  await expect(handle).toHaveAccessibleName(/現在: 小/);

  // つまみの中心を掴んで dy ピクセルだけ動かす（相対移動。閾値の判定と条件を揃える）。
  // 各段のスナップと高さのアニメーション(240ms)が終わってから次を掴む
  const dragBy = async (dy: number) => {
    const box = (await handle.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + dy, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(350);
  };

  // 段の境界（peek と half の中間 ≒ 39dvh）を確実に越え、かつ指が画面内に残る量。
  // 画面外まで動かすと pointerup が届かず、ドラッグもタップも成立しない
  const far = (await page.evaluate(() => window.innerHeight)) * 0.5;

  // 大きく上へ引き上げれば最大まで開く（1段戻ってはいけない）
  await dragBy(-far);
  await expect(handle).toHaveAccessibleName(/現在: 大/);

  // 大きく下げれば畳まれる
  await dragBy(far);
  await expect(handle).toHaveAccessibleName(/現在: 小/);

  // ほとんど動かさない操作はタップとして扱い、次の段階へ進む
  await dragBy(3);
  await expect(handle).toHaveAccessibleName(/現在: 中/);
});

test("他の候補を選ぶと地図の避難先が入れ替わる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("高齢の祖父と一緒。地震のとき逃げられる所を教えて");
  await page.getByRole("button", { name: "避難所をさがす" }).click();
  await expect(page.getByRole("link", { name: "ルート" }).first()).toBeVisible({ timeout: 15_000 });

  // 2位以下を開き、そのうち1件を選ぶ（1位には入れ替えボタンを出さない）
  const others = page.getByText("他の候補");
  await others.scrollIntoViewIfNeeded();
  await others.click();
  const pick = page.getByRole("button", { name: /を地図に表示する$/ }).first();
  const label = (await pick.getAttribute("aria-label")) ?? "";
  const name = label.replace("を地図に表示する", "");
  await pick.click();

  // 地図を見せるためシートが畳まれ、選んだ施設が先頭に来る
  await expect(page.getByRole("button", { name: /情報パネルの高さを変える（現在: 小）/ })).toBeVisible();
  await expect(page.locator("aside")).toContainText(name);
});

test("指で操作する画面では主要な操作要素が44px以上ある", async ({ page }) => {
  // 手が震える状況でも押し間違えないだけの大きさがあること。
  // レイヤのトグル類は検索後にしか描画されないので、相談中と検索後の両方で測る(#118)
  const measure = () =>
    page.evaluate(() => {
      const targets = document.querySelectorAll(
        "aside button, aside select, aside input, aside summary, aside [role=button]"
      );
      return [...targets]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.height < 44;
        })
        .map((el) => `${el.tagName}: ${(el.textContent || "").trim().slice(0, 20)}`);
    });

  await page.goto("/");
  expect(await measure()).toEqual([]);

  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await page.getByRole("button", { name: "避難所をさがす" }).click();
  await expect(page.getByRole("link", { name: "ルート" }).first()).toBeVisible({ timeout: 15_000 });
  // シートを最大まで開いて、畳んでいた操作要素も対象に含める
  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await handle.click();
  await expect(handle).toHaveAccessibleName(/現在: 大/);
  expect(await measure()).toEqual([]);
});

// 結論だけ先に見せ、根拠と2位以下は畳んでおく(#118)。
// 認知負荷を下げる意図なので、既定で開いてしまう回帰を防ぐ
test("根拠と2位以下は畳まれていて、開くと中身が出る", async ({ page }) => {
  await page.goto("/");
  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await page.getByRole("button", { name: "避難所をさがす" }).click();

  const reason = page.getByText("この順位になった理由");
  const others = page.getByText("他の候補");
  await expect(reason).toBeVisible({ timeout: 15_000 });
  await expect(others).toBeVisible();

  // 既定では中身が畳まれている
  await expect(page.getByText("が1位？")).toBeHidden();

  // 開けば根拠が読める
  await reason.scrollIntoViewIfNeeded();
  await reason.click();
  await expect(page.getByText("が1位？")).toBeVisible();

  // 2位以下も開けば出る（1位のカードは畳みの外にあるので常に見えている）。
  // 入れ替えボタンは2位以下にだけ付くので、候補が複数あれば1つ以上出る
  await others.scrollIntoViewIfNeeded();
  await others.click();
  const pickButtons = page.getByRole("button", { name: /を地図に表示する$/ });
  expect(await pickButtons.count()).toBeGreaterThan(0);
});

// OSがダークモードでも配色が崩れないこと。
// 変数だけ dark で切り替えていた頃は、相談モードの見出しと入力欄が
// 「濃紺の地に黒い文字」になって読めなかった（light 固定で解消）
test.describe("配色", () => {
  test.use({ colorScheme: "dark" });
  test("ダークモード設定でも文字が背景に埋もれない", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    // スタイル適用前に測ると地も文字も初期値になり、常に「同じ色」＝比率1で通ってしまう
    await expect(page.locator("h1")).toBeVisible();
    await page.waitForFunction(
      () => getComputedStyle(document.body).backgroundColor === "rgb(248, 250, 252)"
    );
    const c = await page.evaluate(() => {
      // Tailwind v4 の色は getComputedStyle が lab()/oklch() 表記で返すことがあり、
      // 数値を素朴に取り出すと sRGB として誤読してしまう。
      // canvas に塗って実際のピクセル値を読み、確実に RGB へ落とす
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      const toRgb = (css: string): [number, number, number] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = css; // 解釈できない値なら直前の #000 が残る
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const lum = (css: string) => {
        const [r, g, b] = toRgb(css).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bodyBg = lum(getComputedStyle(document.body).backgroundColor);
      const ratio = (fg: number) =>
        (Math.max(fg, bodyBg) + 0.05) / (Math.min(fg, bodyBg) + 0.05);
      const h1 = document.querySelector("h1")!;
      const ta = document.querySelector("textarea")!;
      return {
        h1: ratio(lum(getComputedStyle(h1).color)),
        textarea: ratio(lum(getComputedStyle(ta).color)),
        // 計算が壊れていないことの自己点検（黒対白は 21:1）
        sanity: ratio(lum("#ffffff")) > 0 ? (() => {
          const wl = lum("#ffffff"), bl = lum("#000000");
          return (Math.max(wl, bl) + 0.05) / (Math.min(wl, bl) + 0.05);
        })() : 0,
      };
    });
    // 計算自体が正しいことを先に確かめる（黒対白 = 21:1）
    expect(c.sanity).toBeGreaterThan(20);
    // WCAG AA の本文相当（4.5:1）を満たすこと
    expect(c.h1).toBeGreaterThan(4.5);
    expect(c.textarea).toBeGreaterThan(4.5);
  });
});

// 素早く2回叩いても1段ずつ進むこと（props の snap を直接見ていた頃は
// 再レンダリング前の2回目が同じ遷移を繰り返し、1段しか進まなかった）
test("つまみを続けて叩いても1段ずつ進む", async ({ page }) => {
  await page.goto("/");
  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await page.getByRole("button", { name: "避難所をさがす" }).click();
  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await expect(handle).toHaveAccessibleName(/現在: 中/, { timeout: 15_000 });

  // 待たずに2回続けて叩く: 中 → 大 → 小 と2段進むはず
  await handle.click({ delay: 0 });
  await handle.click({ delay: 0 });
  await expect(handle).toHaveAccessibleName(/現在: 小/);
});

// シートは高さ固定を translateY で下げる作りなので、スクロール領域を可視部分に
// 収めないと下端が画面外に残り、スクロールしても最後まで読めなくなる(#118)
test("中段でもシートの中身を最後までスクロールして読める", async ({ page }) => {
  await page.goto("/");
  await page
    .getByPlaceholder("例）雨の日、車椅子の母と避難したい")
    .fill("大地震で火事が広がっている。足の悪い祖母と逃げたい");
  await page.getByRole("button", { name: "避難所をさがす" }).click();
  const handle = page.getByRole("button", { name: /情報パネルの高さを変える/ });
  await expect(handle).toHaveAccessibleName(/現在: 中/, { timeout: 15_000 });

  // 一番下までスクロールしたとき、最後の要素が画面内に収まること
  const bottom = await page.evaluate(() => {
    const sc = document.querySelector("aside > div:last-child") as HTMLElement | null;
    if (!sc) return null;
    sc.scrollTop = sc.scrollHeight;
    const last = sc.lastElementChild as HTMLElement | null;
    if (!last) return null;
    const r = last.getBoundingClientRect();
    return { bottom: r.bottom, viewport: window.innerHeight };
  });
  expect(bottom).not.toBeNull();
  // 画面の下端より内側にあること（はみ出していれば読めない）
  expect(bottom!.bottom).toBeLessThanOrEqual(bottom!.viewport + 1);
});
