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
  location: string;
  hazard: FallbackHazard;
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
    location: (text.match(/[^\s、。,（）()]{1,8}?(?:区|市|町|村)/) ||
      text.match(/[^\s、。,（）()]{1,12}?駅/) || [""])[0],
    hazard:
      text.includes("洪水") || text.includes("浸水") || text.includes("水害") || text.includes("氾濫")
        ? "flood"
        : text.includes("土砂") || text.includes("崖")
          ? "landslide"
          : text.includes("高潮")
            ? "storm_surge"
            : text.includes("地震")
              ? "earthquake"
              : text.includes("津波")
                ? "tsunami"
                : "none",
  };
}
