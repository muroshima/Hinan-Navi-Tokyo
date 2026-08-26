// 登壇資料用のスクリーンショット。デモをやらずスライドだけで再現するため、
// 画面全体だけでなく「見せたいパネル」を単体でも撮る。
import { chromium, devices } from "@playwright/test";
const OUT = "docs"; // リポジトリルートから実行する
// 既定は開発サーバ。本番相当のビルドで撮りたいときは
// SHOT_URL=http://localhost:3100 のように渡す（開発サーバのままだと
// 本番と描画が変わりうるし、DevTools のバッジも写り込む）
const U = process.env.SHOT_URL ?? "http://localhost:3000";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iPhone } = devices["iPhone 13"];
const HIDE = "nextjs-portal{display:none!important}";
const b = await chromium.launch();

async function search(p, text, coords) {
  await p.goto(coords ? `${U}/?lat=${coords[1]}&lng=${coords[0]}` : U, { waitUntil: "networkidle" });
  await p.addStyleTag({ content: HIDE }).catch(() => {});
  await p.getByPlaceholder("例）雨の日、車椅子の母と避難したい").fill(text);
  await p.getByRole("button", { name: "避難所をさがす" }).click();
  await p.getByText("他の候補").waitFor({ timeout: 40000 });
  await p.waitForTimeout(6000);
  await p.addStyleTag({ content: HIDE }).catch(() => {});
}
// パネル単位で撮る（見出しを含む最小の角丸ブロック）
// maxHeight を渡すと上端からその高さだけを切り出す。
// 縦長のパネルをそのまま貼るとスライドの本文領域(約480px)を超えてフッターに重なる。
// 折りたたみ(#118)の中にあるものは開いてから撮る。
async function panel(p, heading, file, maxHeight) {
  const details = p.locator("aside details").filter({ hasText: heading });
  let el;
  if (await details.count()) {
    el = details.first();
    // 閉じていれば開く
    if (!(await el.evaluate((d) => d.open))) {
      await el.locator("summary").first().click();
      await p.waitForTimeout(300);
    }
  } else {
    el = p.locator("aside div.rounded-lg").filter({ hasText: heading }).last();
  }
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  if (!maxHeight) {
    await el.screenshot({ path: `${OUT}/${file}`, quality: 92, type: "jpeg" });
    return;
  }
  const box = await el.boundingBox();
  if (!box) throw new Error(`「${heading}」のパネルが見えないため撮影できません（折りたたみが開かなかった可能性）`);
  await p.screenshot({
    path: `${OUT}/${file}`, quality: 92, type: "jpeg",
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, maxHeight) },
  });
}

const pc = await (await b.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 })).newPage();

// ⓪ 相談モード（検索前）: 地図を出さず、現在地と相談欄だけ(#118)
await pc.goto(U, { waitUntil: "networkidle" });
await pc.addStyleTag({ content: HIDE }).catch(() => {});
await pc.waitForTimeout(1200);
await pc.screenshot({ path: `${OUT}/shot-consult.jpg`, quality: 92, type: "jpeg" });

// ① 水害・車椅子: 画面全体（自然文→属性→行ける順→地図）
await search(pc, "雨の日、車椅子の母と避難したい。介助は私がします", [139.8683, 35.7068]);
await pc.screenshot({ path: `${OUT}/shot-triage.jpg`, quality: 92, type: "jpeg" });
// ② 1位カード（点数の内訳つき）
await panel(pc, "なぜこの点数？", "shot-breakdown.jpg");

// ③ 地震: 画面全体（町丁目の地域危険度が地図に出ている状態）
await search(pc, "大地震で火事が広がっている。足の悪い祖母と逃げたい", [139.8235, 35.7115]);
await pc.screenshot({ path: `${OUT}/shot-quake.jpg`, quality: 92, type: "jpeg" });
// ④ 現在地の地震リスク
await panel(pc, "いまいる場所の地震リスク", "shot-quake-risk.jpg");
// ⑤ 経路の延焼・液状化チェック
await panel(pc, "避難経路の延焼・液状化チェック", "shot-quake-route.jpg");
// ⑥ 発災起点のタイムライン
await pc.getByRole("button", { name: /行動計画をつくる/ }).click();
await pc.getByRole("button", { name: /作り直す/ }).waitFor({ timeout: 90000 }).catch(() => {});
await pc.waitForTimeout(1500);
await panel(pc, "あなたのマイ・タイムライン", "shot-timeline.jpg", 340); // CSSピクセル。スライド本文領域(約480px)に収まる高さ

// ⑦ 帰宅困難者モード
await search(pc, "職場にいるときに地震が起きた。電車が止まって帰れない", null);
await panel(pc, "外出中に地震が起きたら", "shot-stranded.jpg");

// ⑧ スマホ（ボトムシート）
const sp = await (await b.newContext({ ...iPhone, deviceScaleFactor: 3 })).newPage();
await search(sp, "大地震で火事が広がっている。足の悪い祖母と逃げたい", [139.8235, 35.7115]);
await sp.screenshot({ path: `${OUT}/shot-mobile.jpg`, quality: 92, type: "jpeg" });

await b.close();
console.log("撮影完了");
