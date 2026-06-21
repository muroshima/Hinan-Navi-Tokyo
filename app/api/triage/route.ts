import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { fallbackExtract } from "@/lib/triageFallback";

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
  location: z.string().optional().describe("文中の地名・住所・駅名など避難の出発地。無ければ省略可"),
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
文中に地名・住所・駅名（例「江戸川区」「新宿駅」）があれば location に入れます（無ければ省略）。
hazardは: 水害/氾濫/洪水/浸水→flood、土砂/崖崩れ→landslide、高潮→storm_surge、津波→tsunami、地震→earthquake、火災→fire。
明示されていない属性は false、災害種別の言及がなければ hazard は none にしてください。推測しすぎないこと。`;

// ルールベース簡易抽出は lib/triageFallback の fallbackExtract を共有（オフライン時にクライアントでも使用）

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
