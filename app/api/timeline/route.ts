import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import type { UserAttrs, TimelinePhase } from "@/lib/types";

// 生成する避難タイムラインのスキーマ（内閣府の警戒レベルに沿った局面別の行動）
// 長さ制約で空配列・過剰件数の不正形を弾き、UIが空になるのを防ぐ（不正ならparse失敗→fallback）
const PhaseSchema = z.object({
  phase: z.string().min(1).describe("局面の名前。例: 事前の備え / 情報収集 / 避難開始 / 避難先で"),
  level: z.string().min(1).describe("対応する警戒レベルや時点。例: 警戒レベル3（高齢者等避難）/ 平時"),
  actions: z
    .array(z.string().min(1))
    .min(1)
    .max(8)
    .describe("その局面で取る具体的な行動。利用者の状況に即して目安2〜5個（最大8）"),
});
const TimelineSchema = z.object({
  phases: z
    .array(PhaseSchema)
    .min(1)
    .max(8)
    .describe("時系列の避難行動タイムライン。目安4〜6局面（最大8）"),
});

// 入力の正規化（boolean以外やInfinity等の不正値で500にしない）
const InputAttrsSchema = z.object({
  wheelchair: z.boolean().catch(false),
  elderly: z.boolean().catch(false),
  stroller: z.boolean().catch(false),
  visual_impairment: z.boolean().catch(false),
  hearing_impairment: z.boolean().catch(false),
  foreign_language: z.boolean().catch(false),
  has_caregiver: z.boolean().catch(false),
  ostomate: z.boolean().catch(false),
  severe_care: z.boolean().catch(false),
  night: z.boolean().catch(false),
  bad_weather: z.boolean().catch(false),
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
    ])
    .nullable()
    .catch(null),
});
const InputSchema = z.object({
  attrs: InputAttrsSchema,
  destName: z.string().max(100).optional().catch(undefined),
  hazardLabel: z.string().max(40).optional().catch(undefined),
  distanceKm: z.number().finite().optional().catch(undefined), // Infinity/NaNはundefinedへ
  language: z.enum(["ja-easy", "ja", "en", "zh"]).optional().catch(undefined),
});

// 出力言語の指示（LLM版のみ。fallbackは日本語固定）
const LANG_INSTRUCTION: Record<string, string> = {
  ja: "出力は日本語で書いてください。",
  "ja-easy":
    "出力はやさしい日本語で書いてください（短い文・難しい言葉や漢語を避け、外国人や子どもにも分かる表現にする）。",
  en: "Write the output in English.",
  zh: "请用简体中文输出。",
};

// 返却型は @/lib/types の TimelinePhase に統一（PhaseSchemaと構造一致。二重定義を避ける）

const SYSTEM = `あなたは防災の避難計画（マイ・タイムライン）作成を支援するアシスタントです。
利用者の状況（配慮属性・想定災害・推奨避難先）に合わせ、内閣府の「警戒レベル」(1〜5)に沿った時系列の避難行動を作成します。

重要な原則:
- 避難行動要支援者（車椅子・高齢・要介護・乳幼児連れなど）は【警戒レベル3（高齢者等避難）】の時点で避難を開始するのが原則です。一般の人(レベル4)より早く動くことを必ず明記します。
- 各局面の行動は、利用者の属性に即して具体化します（例: 車椅子→段差の少ない経路と介助手配、要介護→搬送手段と医療物品、乳幼児→ミルク/おむつ、オストメイト→装具のストック、夜間→明るいうちの避難、悪天候→濡れない経路・防水）。
- 一般論を避け、当事者が「次に何をするか」が分かる粒度にします。
- 4〜6局面（例: 事前の備え/情報収集/避難開始/避難中/避難先で）。各局面 actions は2〜5個、簡潔な命令形で。
- 医療・救命の最終判断は本人と自治体・支援者に委ねる前提で、断定的な医療指示はしません。`;

// 警戒レベルに沿ったルールベースのタイムライン（APIキー未設定でも動かす）
function fallbackTimeline(
  attrs: UserAttrs,
  destName?: string,
  hazardLabel?: string
): TimelinePhase[] {
  const isSupport =
    attrs.wheelchair || attrs.elderly || attrs.severe_care || attrs.stroller || attrs.visual_impairment;
  const dest = destName ? `「${destName}」` : "避難先";

  // 事前の備え
  const prep: string[] = ["ハザードマップで自宅の浸水・土砂リスクと避難経路を確認する"];
  if (attrs.severe_care) prep.push("常用薬・医療物品・必要なら吸引器等の予備を持出袋にまとめる");
  if (attrs.ostomate) prep.push("ストーマ装具を最低3日分ストックし持出袋に入れる");
  if (attrs.stroller) prep.push("ミルク・おむつ・母子手帳・抱っこ紐を持出袋に準備する");
  if (attrs.wheelchair) prep.push("車椅子の点検と、段差の少ない避難経路を事前に決めておく");
  if (!attrs.has_caregiver && (attrs.wheelchair || attrs.elderly || attrs.severe_care))
    prep.push("近所・地域の支援者や避難支援プランに早めに連絡し、当日の手助けを確保する");
  if (attrs.foreign_language) prep.push("やさしい日本語/多言語の防災アプリ・連絡先を用意する");

  // 情報収集
  const watch: string[] = [
    "テレビ・防災アプリ・自治体の発令で警戒レベルを確認する",
    `${hazardLabel ?? "災害"}の見込みと避難情報をこまめにチェックする`,
  ];
  if (attrs.night) watch.push("暗くなる前に、明るいうちの早期避難を判断する");
  if (attrs.bad_weather) watch.push("風雨が強まる前に行動する。冠水・倒木で経路が塞がる前に判断する");

  // 避難開始（要配慮者は警戒レベル3）
  const move: string[] = [];
  if (isSupport) move.push(`【警戒レベル3で避難開始】支援が必要なため、一般の人より早く${dest}へ向かう`);
  else move.push(`避難情報に従い${dest}へ向かう`);
  if (attrs.wheelchair) move.push("段差・冠水を避け、エレベーター/スロープのある経路で移動する");
  if (attrs.severe_care) move.push("搬送の人手と車両を手配し、医療物品を携行する");
  if (attrs.stroller) move.push("ベビーカーが使えない道もあるため抱っこ紐を併用する");
  if (attrs.visual_impairment) move.push("介助者と一緒に、点字ブロック等を頼りに安全に移動する");
  if (attrs.bad_weather) move.push("レインウェアで濡れを防ぎ、最短で屋内の避難先に入る");

  // 避難先で
  const after: string[] = [`${dest}で受付し、配慮事項（バリアフリー・医療）を職員に伝える`];
  if (attrs.severe_care || attrs.wheelchair) after.push("必要なら福祉避難所への移動を相談する");
  if (attrs.ostomate) after.push("オストメイト対応トイレの場所を確認する");
  if (attrs.stroller) after.push("授乳・おむつ替えのできる場所を確認する");
  after.push("家族・支援者に避難先と無事を連絡する");

  return [
    { phase: "事前の備え", level: "平時", actions: prep },
    { phase: "情報収集・判断", level: "警戒レベル1〜2", actions: watch },
    {
      phase: "避難開始",
      level: isSupport ? "警戒レベル3（高齢者等避難）" : "警戒レベル4（避難指示）",
      actions: move,
    },
    { phase: "避難先で", level: "避難後", actions: after },
  ];
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    // attrs欠如に限らず入力不正全般で到達するため汎用文言にする
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const attrs: UserAttrs = parsed.data.attrs;
  const { destName, hazardLabel, distanceKm } = parsed.data;
  const language = parsed.data.language ?? "ja";

  // APIキーが無ければルールベースにフォールバック
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      timeline: fallbackTimeline(attrs, destName, hazardLabel),
      source: "fallback",
    });
  }

  const activeAttrs = Object.entries(attrs)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .join(", ");
  const prompt = `利用者の配慮属性: ${activeAttrs || "特になし"}
想定災害: ${hazardLabel ?? "未指定"}
推奨避難先: ${destName ?? "未指定"}${distanceKm != null ? `（現在地から約${distanceKm.toFixed(1)}km）` : ""}

この利用者の状況に合わせた避難のマイ・タイムラインを作成してください。`;

  try {
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      system: `${SYSTEM}\n\n出力言語: ${LANG_INSTRUCTION[language]}`,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: zodOutputFormat(TimelineSchema) },
    });
    const out = res.parsed_output;
    if (!out?.phases?.length) {
      return NextResponse.json({
        timeline: fallbackTimeline(attrs, destName, hazardLabel),
        source: "fallback",
      });
    }
    return NextResponse.json({ timeline: out.phases, source: "claude" });
  } catch (err) {
    // 失敗してもアプリを止めない。詳細はサーバーログのみ（内部情報をクライアントに出さない）
    console.error("timeline error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({
      timeline: fallbackTimeline(attrs, destName, hazardLabel),
      source: "fallback",
    });
  }
}
