import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";

// Claudeに抽出させる利用者属性のスキーマ
const AttrsSchema = z.object({
  wheelchair: z.boolean().describe("車椅子を利用している"),
  elderly: z.boolean().describe("高齢者・歩行に不安がある"),
  stroller: z.boolean().describe("ベビーカー・乳幼児を連れている"),
  visual_impairment: z.boolean().describe("視覚障害がある"),
  hearing_impairment: z.boolean().describe("聴覚障害がある"),
  foreign_language: z.boolean().describe("日本語が不自由・外国語話者である"),
  has_caregiver: z.boolean().describe("介助者・付き添いがいる"),
  ostomate: z.boolean().describe("オストメイト（人工肛門・ストーマ）である"),
  severe_care: z.boolean().describe("寝たきり・重度障害・要介護（大型ベッド等が必要）である"),
  night: z.boolean().describe("夜間・暗い時間帯の避難である"),
  bad_weather: z.boolean().describe("雨・大雨・荒天・台風・雪など悪天候の状況である"),
  location: z.string().describe("文中の地名・住所・駅名など避難の出発地。無ければ空文字"),
  hazard: z
    .enum([
      "flood",
      "landslide",
      "storm_surge",
      "earthquake",
      "tsunami",
      "fire",
      "inland_flood",
      "volcano",
      "none",
    ])
    .describe("想定している災害。明示がなければ none"),
});

const SYSTEM = `あなたは防災避難支援アシスタントです。利用者が自然文で伝える状況から、避難所選定に必要な属性を抽出します。
本人だけでなく同行者（例: 車椅子の母と避難）の配慮要件も該当属性を true にします。
オストメイト/人工肛門/ストーマ → ostomate、寝たきり/重度/要介護 → severe_care、夜間/暗い時間帯 → night、雨・大雨・台風・雪などの悪天候 → bad_weather を true にします。
文中に地名・住所・駅名（例「江戸川区」「新宿駅」）があれば location に入れます（無ければ空文字）。
明示されていない属性は false、災害種別の言及がなければ hazard は none にしてください。推測しすぎないこと。`;

// キー未設定時のルールベース簡易抽出（スケルトンをキーなしでも動かすため）
function fallbackExtract(text: string) {
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
    location: (text.match(/[^\s、。,]{1,10}(?:区|市|町|村)/) || text.match(/[^\s、。,]{1,12}駅/) || [""])[0],
    hazard: (text.includes("洪水") || text.includes("浸水") || text.includes("水害") || text.includes("氾濫")
      ? "flood"
      : text.includes("土砂") || text.includes("崖")
        ? "landslide"
        : text.includes("高潮")
          ? "storm_surge"
          : text.includes("地震")
            ? "earthquake"
            : text.includes("津波")
              ? "tsunami"
              : "none") as
      | "flood"
      | "landslide"
      | "storm_surge"
      | "earthquake"
      | "tsunami"
      | "none",
  };
}

export async function POST(req: NextRequest) {
  let text = "";
  try {
    const body = await req.json();
    text = (body?.text ?? "").toString().slice(0, 1000);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // APIキーが無ければルールベースにフォールバック
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ attrs: fallbackExtract(text), source: "fallback" });
  }

  try {
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
      output_config: { format: zodOutputFormat(AttrsSchema) },
    });
    const attrs = res.parsed_output;
    if (!attrs) {
      return NextResponse.json({ attrs: fallbackExtract(text), source: "fallback" });
    }
    return NextResponse.json({ attrs, source: "claude" });
  } catch (err) {
    // 失敗時もスケルトンを止めない。詳細はサーバーログのみ（クライアントへ内部情報を出さない）
    console.error("triage error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ attrs: fallbackExtract(text), source: "fallback" });
  }
}
