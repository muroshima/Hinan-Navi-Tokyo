import { Type } from "@google/genai";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { getGeminiClient, GEMINI_MODEL } from "@/lib/gemini";
import { fallbackExtract } from "@/lib/triageFallback";
import { enforceRateLimit, TtlCache } from "@/lib/rateLimit";

// 抽出結果の検証用スキーマ（Geminiの構造化出力を最終検証して型安全にする）
const AttrsSchema = z.object({
  wheelchair: z.boolean(),
  elderly: z.boolean(),
  stroller: z.boolean(),
  visual_impairment: z.boolean(),
  hearing_impairment: z.boolean(),
  foreign_language: z.boolean(),
  has_caregiver: z.boolean(),
  ostomate: z.boolean(),
  severe_care: z.boolean(),
  night: z.boolean(),
  bad_weather: z.boolean(),
  location: z.string().default(""), // 常にstringに正規化（fallbackとレスポンス形を揃える）
  hazard: z.enum([
    "flood",
    "landslide",
    "storm_surge",
    "earthquake",
    "tsunami",
    "fire",
    "inland_flood",
    "volcano",
    "none",
  ]),
});
type Attrs = z.infer<typeof AttrsSchema>;

// 同一入力の再問い合わせ（デモの再現操作・リロード）でGeminiを再度叩かないための簡易キャッシュ
const triageCache = new TtlCache<Attrs>(500, 10 * 60_000);

// Gemini の responseSchema（OpenAPI風）。required で全項目を明示し欠損を防ぐ
const GEMINI_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    wheelchair: { type: Type.BOOLEAN, description: "車椅子を利用している" },
    elderly: { type: Type.BOOLEAN, description: "高齢者・歩行に不安がある" },
    stroller: { type: Type.BOOLEAN, description: "ベビーカー・乳幼児を連れている" },
    visual_impairment: { type: Type.BOOLEAN, description: "視覚障害がある" },
    hearing_impairment: { type: Type.BOOLEAN, description: "聴覚障害がある" },
    foreign_language: { type: Type.BOOLEAN, description: "日本語が不自由・外国語話者である" },
    has_caregiver: { type: Type.BOOLEAN, description: "介助者・付き添いがいる" },
    ostomate: { type: Type.BOOLEAN, description: "オストメイト（人工肛門・ストーマ）である" },
    severe_care: { type: Type.BOOLEAN, description: "寝たきり・重度障害・要介護である" },
    night: { type: Type.BOOLEAN, description: "夜間・暗い時間帯の避難である" },
    bad_weather: { type: Type.BOOLEAN, description: "雨・大雨・荒天・台風・雪など悪天候である" },
    location: { type: Type.STRING, description: "文中の地名・住所・駅名など出発地。無ければ空文字" },
    hazard: {
      type: Type.STRING,
      enum: [
        "flood",
        "landslide",
        "storm_surge",
        "earthquake",
        "tsunami",
        "fire",
        "inland_flood",
        "volcano",
        "none",
      ],
      description: "想定している災害。明示がなければ none",
    },
  },
  required: [
    "wheelchair",
    "elderly",
    "stroller",
    "visual_impairment",
    "hearing_impairment",
    "foreign_language",
    "has_caregiver",
    "ostomate",
    "severe_care",
    "night",
    "bad_weather",
    "location",
    "hazard",
  ],
};

const SYSTEM = `あなたは防災避難支援アシスタントです。利用者が自然文で伝える状況から、避難所選定に必要な属性を抽出します。
本人だけでなく同行者（例: 車椅子の母と避難）の配慮要件も該当属性を true にします。
オストメイト/人工肛門/ストーマ → ostomate、寝たきり/重度/要介護 → severe_care、夜間/暗い時間帯 → night、雨・大雨・台風・雪などの悪天候 → bad_weather を true にします。
文中に地名・住所・駅名（例「江戸川区」「新宿駅」）があれば location に入れます（無ければ空文字）。
hazardは: 水害/氾濫/洪水/浸水→flood、内水氾濫→inland_flood、土砂/崖崩れ→landslide、高潮→storm_surge、津波→tsunami、地震→earthquake、火災/火事→fire、火山/噴火→volcano。
明示されていない属性は false、災害種別の言及がなければ hazard は none にしてください。推測しすぎないこと。`;

export async function POST(req: NextRequest) {
  // IP単位レート制限（Geminiコスト悪用対策・#30）。制限内ならnull
  const limited = enforceRateLimit("triage", req, 15, 60_000);
  if (limited) return limited;

  let text = "";
  try {
    const body = await req.json();
    // 受信直後に一度だけ正規化（trim→1000文字）。以降 cacheKey/Gemini/fallback で同一値を使い冪等性を担保
    text = (body?.text ?? "").toString().trim().slice(0, 1000);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // Vertex(project/認証)が無ければ語句一致fallback
  const ai = getGeminiClient();
  if (!ai) {
    return NextResponse.json({ attrs: fallbackExtract(text), source: "fallback" });
  }

  // 同一入力はキャッシュから返しGemini呼び出しを節約（textは受信時に正規化済み）
  const cacheKey = text;
  const cached = triageCache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ attrs: cached, source: "gemini" });
  }

  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: text,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
      },
    });
    const parsed = AttrsSchema.safeParse(JSON.parse(res.text ?? "{}"));
    if (!parsed.success) {
      return NextResponse.json({ attrs: fallbackExtract(text), source: "fallback" });
    }
    triageCache.set(cacheKey, parsed.data);
    return NextResponse.json({ attrs: parsed.data, source: "gemini" });
  } catch (err) {
    // 失敗時もアプリを止めない。詳細はサーバーログのみ（内部情報をクライアントに出さない）
    console.error("triage error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ attrs: fallbackExtract(text), source: "fallback" });
  }
}
