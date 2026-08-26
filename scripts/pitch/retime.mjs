#!/usr/bin/env node
// カンペの見出しの時間配分を、実際の字数から振り直す。
// 原稿を直すたびに手で時刻を直すと必ずどこかがずれる（実際、まとめだけ
// 452字/分という不可能な割当になっていた）。字数から機械的に決める。
import fs from "fs";

const PATH = process.argv[2] ?? "docs/talk_script.md";
const CPM = Number(process.env.CPM ?? 275);
const TOTAL = Number(process.env.TOTAL_SEC ?? 600); // 持ち時間(秒)
const STEP = 5; // 5秒単位に丸める（1秒刻みの割当は読み手が使えない）

const text = fs.readFileSync(PATH, "utf8");
const lines = text.split("\n");

// 各セクションの読み上げ字数を数える（count_script.mjs と同じ数え方）
const heads = [];
let cur = null, inOptional = false;
lines.forEach((line, i) => {
  const m = line.match(/^##\s+(.+?)（(\d+):(\d+)-(\d+):(\d+)）(.*)$/);
  if (m) { cur = { i, title: m[1], suffix: m[6], chars: 0 }; heads.push(cur); inOptional = false; return; }
  if (/^⏱/.test(line)) { inOptional = true; return; }
  if (/^##\s/.test(line)) { inOptional = false; return; }
  if (!cur || !line.startsWith("> ") || inOptional) return;
  cur.chars += line.slice(2).replace(/[\s*_`「」『』（）()、。・—→…]/g, "").length;
});
if (!heads.length) { console.error("セクションが見つかりません"); process.exit(1); }

// 字数の比で持ち時間を分け、5秒単位に丸める
const sum = heads.reduce((a, h) => a + h.chars, 0);
let alloc = heads.map((h) => Math.max(STEP, Math.round((h.chars / sum) * TOTAL / STEP) * STEP));
// 丸めで生じた差は 5秒ずつ、長いセクションから順に配る。
// 1か所へまとめて寄せると、そのセクションだけ割当と実測が大きくずれる
// （地震パートに13秒乗って「237字/分」という緩すぎる配分になっていた）
let diff = TOTAL - alloc.reduce((a, b) => a + b, 0);
const order = alloc.map((_, i) => i).sort((x, y) => alloc[y] - alloc[x]);
for (let k = 0; diff !== 0 && k < order.length * 20; k++) {
  const i = order[k % order.length];
  const d = diff > 0 ? STEP : -STEP;
  if (alloc[i] + d >= STEP) {
    alloc[i] += d;
    diff -= d;
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
let t = 0;
heads.forEach((h, k) => {
  const from = t, to = t + alloc[k];
  t = to;
  lines[h.i] = `## ${h.title}（${fmt(from)}-${fmt(to)}）${h.suffix}`;
  console.log(`  ${h.title.padEnd(34)} ${fmt(from)}-${fmt(to)}  (${alloc[k]}s / ${h.chars}字)`);
});
fs.writeFileSync(PATH, lines.join("\n"));
console.log(`\n合計 ${fmt(TOTAL)} に振り直しました（話速 ${CPM}字/分・${STEP}秒単位）`);
