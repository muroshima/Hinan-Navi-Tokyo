// 自然文から配慮属性を語句一致で抽出するルールベースfallback。
// LLMキー未設定時(サーバー)と、オフライン時(クライアント)の両方で使う共有ロジック。
import type { HazardKey } from "./types";

export type FallbackHazard = HazardKey | "none";

export interface FallbackAttrs {
  wheelchair: boolean;
  elderly: boolean;
  stroller: boolean;
  visual_impairment: boolean;
  hearing_impairment: boolean;
  foreign_language: boolean;
  has_caregiver: boolean;
  ostomate: boolean;
  severe_care: boolean;
  night: boolean;
  bad_weather: boolean;
  outside: boolean;
  location: string;
  hazard: FallbackHazard;
}

// 想定災害の語句一致。route.ts の hazard enum を全て網羅（順序＝優先度。内水氾濫を洪水より先に判定）
function detectHazard(text: string): FallbackHazard {
  const rules: [FallbackHazard, string[]][] = [
    ["inland_flood", ["内水"]],
    ["flood", ["洪水", "浸水", "水害", "氾濫"]],
    ["landslide", ["土砂", "崖"]],
    ["storm_surge", ["高潮"]],
    ["tsunami", ["津波"]],
    ["earthquake", ["地震"]],
    ["fire", ["火災", "火事"]],
    ["volcano", ["火山", "噴火"]],
  ];
  for (const [h, kws] of rules) if (kws.some((k) => text.includes(k))) return h;
  return "none";
}

export function fallbackExtract(text: string): FallbackAttrs {
  const has = (...kw: string[]) => kw.some((k) => text.includes(k));
  return {
    wheelchair: has("車椅子", "車いす", "车椅子"),
    elderly: has("高齢", "祖母", "祖父", "お年寄り", "歩けない", "足が悪い"),
    stroller: has("ベビーカー", "乳児", "赤ちゃん", "子連れ", "幼児", "子ども", "子供"),
    visual_impairment: has("視覚障害", "目が不自由", "盲", "見えない"),
    hearing_impairment: has("聴覚障害", "耳が不自由", "聞こえない"),
    foreign_language: has("English", "英語", "中文", "한국", "わからない言葉"),
    has_caregiver:
      has("介助", "付き添い", "一緒", "母と", "父と", "家族と") &&
      !has("介助者なし", "介助なし", "付き添いなし", "一人で", "ひとりで", "独りで", "1人で"),
    ostomate: has("オストメイト", "人工肛門", "ストーマ"),
    severe_care: has("寝たきり", "重度", "要介護", "大型ベッド", "着替え介助", "介護が必要", "車いす全介助"),
    night: has("夜", "夜間", "今夜", "未明", "暗い", "深夜"),
    bad_weather: has("雨", "大雨", "荒天", "台風", "嵐", "暴風", "雪", "悪天候"),
    // 外出中＝地震では帰宅困難になり得る。自宅にいる前提と読める語は拾わない
    outside: has(
      "外出",
      "職場",
      "会社",
      "勤務",
      "学校",
      "通勤",
      "通学",
      "出先",
      "買い物中",
      "電車",
      "駅にい",
      "帰宅困難",
      "帰れな"
    ),
    location: (text.match(/[^\s、。,（）()]{1,8}?(?:区|市|町|村)/) ||
      text.match(/[^\s、。,（）()]{1,12}?駅/) || [""])[0],
    hazard: detectHazard(text),
  };
}
