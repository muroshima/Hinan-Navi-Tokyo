#!/usr/bin/env node
// レイアウト検査。overflow だけでは足りない（フッターと本文の重なりは scrollHeight では出ない）。
// Marp の HTML を開いて、各スライドの本文がフッター/ページ番号と矩形で交差していないか見る。
import { chromium } from "@playwright/test";
import fs from "fs";

const HTML = process.argv[2] ?? "docs/slides.html";
if (!fs.existsSync(HTML)) {
  console.error(`${HTML} がありません。先に HTML を出力してください:\n  npx -y @marp-team/marp-cli@4.3.1 docs/slides.md -c marp.config.mjs -o docs/slides.html --no-stdin`);
  process.exit(1);
}
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("file://" + process.cwd() + "/" + HTML, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);

const findings = await p.evaluate(() => {
  const out = [];
  const slides = [...document.querySelectorAll("svg[data-marpit-svg] foreignObject > section, section")];
  slides.forEach((sec, i) => {
    const n = i + 1;
    // ① はみ出し
    if (sec.scrollHeight > sec.clientHeight + 2) {
      out.push({ n, kind: "overflow", detail: `本文が ${sec.scrollHeight - sec.clientHeight}px はみ出し` });
    }
    // ② フッター／ページ番号との重なり
    const footers = [...sec.querySelectorAll("footer, .footer, [data-marpit-pagination]")];
    const others = [...sec.querySelectorAll("h1,h2,h3,p,ul,ol,img,div,table,span")].filter(
      (el) => !footers.some((f) => f === el || f.contains(el) || el.contains(f))
    );
    for (const f of footers) {
      const fr = f.getBoundingClientRect();
      if (fr.width === 0 || fr.height === 0) continue;
      for (const el of others) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const overlap = !(r.right < fr.left || r.left > fr.right || r.bottom < fr.top || r.top > fr.bottom);
        if (overlap && r.height < 400) {
          out.push({ n, kind: "footer-overlap", detail: `${el.tagName.toLowerCase()}「${(el.textContent||"").trim().slice(0,18)}」がフッターと重なる` });
          break;
        }
      }
    }
  });
  return out;
});

const total = await p.evaluate(() => document.querySelectorAll("svg[data-marpit-svg]").length || document.querySelectorAll("section").length);
console.log(`スライド ${total} 枚を検査\n`);
if (!findings.length) {
  console.log("  はみ出し・フッター重なり なし");
} else {
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.n}-${f.kind}-${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ⚠️ p${f.n} [${f.kind}] ${f.detail}`);
  }
}
await b.close();
