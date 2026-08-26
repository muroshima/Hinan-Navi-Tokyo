#!/usr/bin/env node
// カンペの尺を字数から実測する。感覚の「10分くらい」は必ず外れるので機械で出す。
// 読み上げ行は "> " で始まる行だけを数える（⏱ 余ったら／舞台裏メモは除く）。
import fs from "fs";

const PATH = process.argv[2] ?? "docs/talk_script.md";
const CPM = Number(process.env.CPM ?? 275); // 字/分。日本語プレゼンの現実的な範囲 250〜300
const TOLERANCE_SEC = 10; // 話速の推定自体に幅があるので、これ以内は誤差として扱う

const lines = fs.readFileSync(PATH, "utf8").split("\n");
const sections = [];
let cur = null;
let inOptional = false;

for (const line of lines) {
  const head = line.match(/^##\s+(.+?)（(\d+):(\d+)-(\d+):(\d+)）/);
  if (head) {
    cur = {
      title: head[1].replace(/★.*$/, "").trim(),
      from: +head[2] * 60 + +head[3],
      to: +head[4] * 60 + +head[5],
      chars: 0,
      optionalChars: 0,
    };
    sections.push(cur);
    inOptional = false;
    continue;
  }
  if (/^⏱/.test(line)) { inOptional = true; continue; }
  if (/^##\s/.test(line)) { inOptional = false; continue; }
  if (!cur || !line.startsWith("> ")) continue;
  // 記号・空白を除いた実質の字数で数える
  const n = line.slice(2).replace(/[\s*_`「」『』（）()、。・—→…]/g, "").length;
  if (inOptional) cur.optionalChars += n; else cur.chars += n;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
let totalEst = 0, totalAlloc = 0, warn = 0;
console.log(`話速 ${CPM}字/分 で計算（許容±${TOLERANCE_SEC}秒）\n`);
console.log("  " + "セクション".padEnd(30) + "割当   推定   差   実話速");
for (const s of sections) {
  const est = (s.chars / CPM) * 60;
  const alloc = s.to - s.from;
  const diff = est - alloc;
  totalEst += est; totalAlloc += alloc;
  const flag = Math.abs(diff) > TOLERANCE_SEC ? (diff > 0 ? " ← 長い" : " ← 余る") : "";
  if (flag) warn++;
  const rate = alloc > 0 ? Math.round((s.chars / alloc) * 60) : 0;
  console.log(`  ${s.title.slice(0, 28).padEnd(30)}${String(alloc).padStart(3)}s ${String(Math.round(est)).padStart(5)}s ${String(Math.round(diff)).padStart(5)}s ${String(rate).padStart(5)}字/分${flag}`);
}
console.log(`\n  合計: 割当 ${fmt(totalAlloc)} / 推定 ${fmt(totalEst)}（差 ${Math.round(totalEst - totalAlloc)}秒）`);
const opt = sections.reduce((a, s) => a + s.optionalChars, 0);
console.log(`  ⏱ 余ったら の追加分: ${opt}字 ≒ ${Math.round((opt / CPM) * 60)}秒`);
console.log(`  話速の幅で見た合計: ${fmt((sections.reduce((a,s)=>a+s.chars,0)/300)*60)}（速い300字/分）〜 ${fmt((sections.reduce((a,s)=>a+s.chars,0)/250)*60)}（遅い250字/分）`);
if (warn) console.log(`\n  ⚠️ 割当と推定が${TOLERANCE_SEC}秒以上ずれるセクション: ${warn}件`);
