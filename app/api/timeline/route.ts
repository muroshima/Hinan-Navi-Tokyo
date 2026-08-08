import { Type } from "@google/genai";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import type { UserAttrs, TimelinePhase, Lang } from "@/lib/types";
import { LANG_CODES } from "@/lib/types";
import { getGeminiClient, GEMINI_MODEL } from "@/lib/gemini";
import { enforceRateLimit, TtlCache, stableKey } from "@/lib/rateLimit";

// 同一入力の再問い合わせでGeminiを再度叩かないための簡易キャッシュ（コスト削減）
const timelineCache = new TtlCache<TimelinePhase[]>(300, 10 * 60_000);

// 生成する避難タイムラインのスキーマ（内閣府の警戒レベルに沿った局面別の行動）
// 長さ制約で空配列・過剰件数の不正形を弾き、UIが空になるのを防ぐ（不正ならparse失敗→fallback）
const PhaseSchema = z.object({
  phase: z.string().min(1).describe("局面の名前。例: 事前の備え / 情報収集 / 避難開始 / 避難先で"),
  level: z
    .string()
    .min(1)
    .describe(
      "対応する警戒レベルや時点。気象災害は例「警戒レベル3（高齢者等避難）」、地震は例「発災直後（0〜3分）」"
    ),
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

// Gemini の responseSchema（TimelineSchema と構造一致）
const GEMINI_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    phases: {
      type: Type.ARRAY,
      description: "時系列の避難行動タイムライン。目安4〜6局面",
      items: {
        type: Type.OBJECT,
        properties: {
          phase: { type: Type.STRING, description: "局面の名前（例: 避難開始）" },
          level: { type: Type.STRING, description: "対応する警戒レベルや時点" },
          actions: {
            type: Type.ARRAY,
            description: "その局面で取る具体的な行動。目安2〜5個",
            items: { type: Type.STRING },
          },
        },
        required: ["phase", "level", "actions"],
      },
    },
  },
  required: ["phases"],
};

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
  outside: z.boolean().catch(false),
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
// 現在地の地震リスク（#106）。クライアントが町丁目危険度・想定震度から算出して渡す
const QuakeInputSchema = z.object({
  fireRank: z.number().int().min(1).max(5).nullable().catch(null),
  buildingRank: z.number().int().min(1).max(5).nullable().catch(null),
  totalRank: z.number().int().min(1).max(5).nullable().catch(null),
  shindo: z.number().finite().nullable().catch(null),
  liquefactionPL: z.number().finite().nullable().catch(null),
});
type QuakeInput = z.infer<typeof QuakeInputSchema>;

const InputSchema = z.object({
  attrs: InputAttrsSchema,
  destName: z.string().max(100).optional().catch(undefined),
  hazardLabel: z.string().max(40).optional().catch(undefined),
  distanceKm: z.number().finite().optional().catch(undefined), // Infinity/NaNはundefinedへ
  language: z.enum(LANG_CODES).optional().catch(undefined),
  quake: QuakeInputSchema.optional().catch(undefined),
});

// 出力言語の指示（LLM版のみ。fallbackは日本語固定）。
// satisfiesでキーをLang全網羅に固定し、言語の増減時に型でドリフトを検出する
const LANG_INSTRUCTION = {
  ja: "出力は日本語で書いてください。",
  "ja-easy":
    "出力はやさしい日本語で書いてください（短い文・難しい言葉や漢語を避け、外国人や子どもにも分かる表現にする）。",
  en: "Write the output in English.",
  zh: "请用简体中文输出。",
} satisfies Record<Lang, string>;

// 返却型は @/lib/types の TimelinePhase に統一（PhaseSchemaと構造一致。二重定義を避ける）

// 地震は予報が出ないため、気象災害の警戒レベル（1〜5）を時間軸にできない。
// 「発災してから何分後に何をするか」を軸に組み替える。
const SYSTEM_QUAKE = `あなたは地震に備える避難計画（マイ・タイムライン）作成を支援するアシスタントです。
利用者の状況（配慮属性・推奨避難先）に合わせ、【発災を起点とした時間軸】で行動を作成します。

重要な原則:
- 地震には警戒レベルも予報もありません。時間軸は「事前の備え（平時）／発災直後（0〜3分）／揺れが収まって（3〜10分）／その後（10分〜数時間）／数時間〜数日」を使います。警戒レベルという言葉は使いません。
- 発災直後にまずすることは避難ではなく【その場で身を守ること】です。車椅子ならブレーキをかけて頭と首を守る、寝たきりなら布団や枕で頭部を保護する、など属性に即して具体化します。
- 揺れが収まったら、火の始末・出口の確保・足元の安全（ガラス・転倒物）を先に行います。スリッパや靴を履くことは要配慮者ほど重要です。
- 【全員がすぐ避難所へ行くわけではありません】。自宅が無事なら在宅避難が基本で、避難が必要なのは「延焼が迫る」「建物が危険」「ライフラインが断たれ生活できない」場合です。この判断基準を必ず示します。
- 延焼火災が迫る場合は、屋内の指定避難所ではなく【屋外の広域避難場所】へ向かうのが原則です。水害とは逆になることを明示します。
- 液状化が想定される地域では、路面の段差・噴砂で車椅子やベビーカーが進めなくなります。該当する属性があれば代替手段（担架・背負い・人手の確保）に触れます。
- 単身で支援が必要な人は、無理に動かず【助けを呼ぶ・居場所を知らせる】ことが正解になる場合があります。ホイッスルや携帯の音、玄関の解錠など具体的に書きます。
- 外出中（帰宅困難）の場合は【むやみに移動を開始しない】が大原則です。一時滞在施設で待機し、鉄道の再開や安否確認の手順を書きます。
- 4〜6局面。各局面 actions は2〜5個、簡潔な命令形で。
- 医療・救命の最終判断は本人と自治体・支援者に委ねる前提で、断定的な医療指示はしません。`;

const SYSTEM = `あなたは防災の避難計画（マイ・タイムライン）作成を支援するアシスタントです。
利用者の状況（配慮属性・想定災害・推奨避難先）に合わせ、内閣府の「警戒レベル」(1〜5)に沿った時系列の避難行動を作成します。

重要な原則:
- 避難行動要支援者（車椅子・高齢・要介護・乳幼児連れなど）は【警戒レベル3（高齢者等避難）】の時点で避難を開始するのが原則です。一般の人(レベル4)より早く動くことを必ず明記します。
- 各局面の行動は、利用者の属性に即して具体化します（例: 車椅子→段差の少ない経路と介助手配、要介護→搬送手段と医療物品、乳幼児→ミルク/おむつ、オストメイト→装具のストック、夜間→明るいうちの避難、悪天候→濡れない経路・防水）。
- 一般論を避け、当事者が「次に何をするか」が分かる粒度にします。
- 4〜6局面（例: 事前の備え/情報収集/避難開始/避難中/避難先で）。各局面 actions は2〜5個、簡潔な命令形で。
- 医療・救命の最終判断は本人と自治体・支援者に委ねる前提で、断定的な医療指示はしません。`;

// 発災起点のルールベース地震タイムライン（LLM未設定・オフラインでも動かす）
function fallbackQuakeTimeline(
  attrs: UserAttrs,
  destName?: string,
  quake?: QuakeInput
): TimelinePhase[] {
  const dest = destName ? `「${destName}」` : "避難先";
  const isSupport =
    attrs.wheelchair || attrs.elderly || attrs.severe_care || attrs.stroller || attrs.visual_impairment;
  const alone = !attrs.has_caregiver && (attrs.wheelchair || attrs.elderly || attrs.severe_care);

  // 事前の備え
  const prep: string[] = [
    "家具・家電を固定し、寝る場所と避難経路に倒れてくる物を置かない",
    "室内で靴やスリッパをすぐ履ける場所に置く（ガラス片で足を切ると避難できなくなる）",
  ];
  if (attrs.wheelchair) prep.push("車椅子の予備タイヤ・パンク修理具を備え、段差解消の代替経路を決めておく");
  if (attrs.severe_care) prep.push("常用薬・医療物品を最低3日分、停電時の電源確保も含めて準備する");
  if (attrs.ostomate) prep.push("ストーマ装具を最低3日分ストックし、持ち出せる場所に置く");
  if (attrs.stroller) prep.push("ミルク・おむつ・抱っこ紐を用意する（がれきの道でベビーカーは使えない）");
  if (alone) prep.push("近所・地域の支援者に、助けが必要なことと居場所を事前に伝えておく");

  // 発災直後
  const now: string[] = [];
  if (attrs.wheelchair) now.push("車椅子のブレーキをかけ、頭と首をクッションや腕で守る。窓・棚から離れる");
  else if (attrs.severe_care) now.push("布団・枕で頭部を保護する。移動させず、家具の転倒範囲から遠ざける");
  else now.push("頭を守り、その場でじっとして揺れが収まるのを待つ（あわてて外へ出ない）");
  if (attrs.visual_impairment) now.push("その場から動かず、落下物が止まるまで待つ。周囲に声を出して居場所を知らせる");
  if (attrs.hearing_impairment) now.push("揺れが収まったら周囲の掲示・スマホの文字情報で状況を確認する");
  if (attrs.stroller) now.push("子どもに覆いかぶさって頭を守る");

  // 揺れが収まって
  const after: string[] = [
    "火を止め、ブレーカーを落とす（通電火災を防ぐ）",
    "ドアや窓を開けて出口を確保し、靴を履いて足元を守る",
  ];
  if (alone) after.push("自力で動けなければ無理をせず、ホイッスル・大きな音で助けを求め、玄関の鍵を開けておく");
  if (attrs.severe_care) after.push("医療機器の電源とバッテリー残量を確認する");

  // 避難するか判断
  const judge: string[] = [
    "自宅が無事なら在宅避難が基本。避難するのは「火が迫る」「建物が危険」「生活できない」ときと決めておく",
    `延焼が迫る場合は屋内の避難所ではなく、広い屋外の避難場所へ向かう（水害と逆）`,
  ];
  if (isSupport) judge.push(`移動には人手と時間がかかる。迷ったら早めに${dest}へ向かう判断をする`);
  if (attrs.wheelchair || attrs.stroller)
    judge.push("液状化や段差で車輪が使えないことがある。担架・背負い等の代替手段を確保する");
  if (attrs.outside)
    judge.push("外出中はむやみに歩き出さず、一時滞在施設で待機して鉄道の再開を待つ");
  // 現在地の地域危険度が分かっていれば、判断材料として具体的に織り込む
  if (quake?.fireRank != null && quake.fireRank >= 4)
    judge.push("この地域は延焼の危険が高い（地域危険度ランク4以上）。煙が見えたら迷わず広い場所へ移動する");
  if (quake?.liquefactionPL != null && quake.liquefactionPL > 15)
    judge.push("液状化の危険度が極めて高い地域。噴砂と段差で道が使えない前提で経路を選ぶ");

  // 避難後・数日
  const life: string[] = [`${dest}で受付し、配慮事項（バリアフリー・医療・服薬）を職員に伝える`];
  if (attrs.severe_care || attrs.wheelchair) life.push("必要なら福祉避難所への移動を相談する");
  if (attrs.ostomate) life.push("オストメイト対応トイレの場所を確認する");
  if (attrs.stroller) life.push("授乳・おむつ替えのできる場所を確認する");
  life.push("余震に備え、家族・支援者に居場所と無事を伝える");

  return [
    { phase: "事前の備え", level: "平時", actions: prep },
    { phase: "身を守る", level: "発災直後（0〜3分）", actions: now },
    { phase: "安全を確保する", level: "揺れが収まって（3〜10分）", actions: after },
    { phase: "避難するか判断する", level: "その後（10分〜数時間）", actions: judge },
    { phase: "避難先・在宅避難で", level: "数時間〜数日", actions: life },
  ];
}

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

/** 想定災害が地震・大規模火事なら発災起点、それ以外は警戒レベル起点のタイムラインを返す */
function isQuake(attrs: UserAttrs): boolean {
  return attrs.hazard === "earthquake" || attrs.hazard === "fire";
}

function buildFallback(
  attrs: UserAttrs,
  destName?: string,
  hazardLabel?: string,
  quake?: QuakeInput
): TimelinePhase[] {
  return isQuake(attrs)
    ? fallbackQuakeTimeline(attrs, destName, quake)
    : fallbackTimeline(attrs, destName, hazardLabel);
}

// 現在地の地震リスクをプロンプトの一行にする（値が無ければ空文字）
function quakeContextLine(quake?: QuakeInput): string {
  if (!quake) return "";
  const parts: string[] = [];
  if (quake.totalRank != null) parts.push(`総合危険度ランク${quake.totalRank}`);
  if (quake.fireRank != null) parts.push(`火災危険度ランク${quake.fireRank}`);
  if (quake.buildingRank != null) parts.push(`建物倒壊危険度ランク${quake.buildingRank}`);
  if (quake.shindo != null) parts.push(`想定計測震度${quake.shindo.toFixed(1)}`);
  if (quake.liquefactionPL != null) parts.push(`液状化PL値${quake.liquefactionPL.toFixed(1)}`);
  return parts.length ? `現在地の地震リスク（東京都の地域危険度・被害想定）: ${parts.join(" / ")}` : "";
}

export async function POST(req: NextRequest) {
  // IP単位レート制限（Geminiコスト悪用対策・#30）
  const limited = enforceRateLimit("timeline", req, 15, 60_000);
  if (limited) return limited;

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
  const { destName, hazardLabel, distanceKm, quake } = parsed.data;
  const language = parsed.data.language ?? "ja";

  // Vertex(project/認証)が無ければルールベースにフォールバック
  const ai = getGeminiClient();
  if (!ai) {
    return NextResponse.json({
      timeline: buildFallback(attrs, destName, hazardLabel, quake),
      source: "fallback",
    });
  }

  // 同一入力はキャッシュから返しGemini呼び出しを節約（距離は0.1km粒度に丸め、キー順非依存で安定化）
  const cacheKey = stableKey({
    attrs,
    destName,
    hazardLabel,
    distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : undefined,
    language,
    quake,
  });
  const cachedTimeline = timelineCache.get(cacheKey);
  if (cachedTimeline) {
    return NextResponse.json({ timeline: cachedTimeline, source: "gemini" });
  }

  const activeAttrs = Object.entries(attrs)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .join(", ");
  const quakeLine = isQuake(attrs) ? quakeContextLine(quake) : "";
  const prompt = `利用者の配慮属性: ${activeAttrs || "特になし"}
想定災害: ${hazardLabel ?? "未指定"}
推奨避難先: ${destName ?? "未指定"}${distanceKm != null ? `（現在地から約${distanceKm.toFixed(1)}km）` : ""}${quakeLine ? `\n${quakeLine}` : ""}

この利用者の状況に合わせた避難のマイ・タイムラインを作成してください。`;

  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        // 地震は警戒レベルで時間軸を作れないため、発災起点の指示に切り替える
        systemInstruction: `${isQuake(attrs) ? SYSTEM_QUAKE : SYSTEM}\n\n出力言語: ${LANG_INSTRUCTION[language]}`,
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
      },
    });
    const out = TimelineSchema.safeParse(JSON.parse(res.text ?? "{}"));
    if (!out.success || out.data.phases.length === 0) {
      return NextResponse.json({
        timeline: buildFallback(attrs, destName, hazardLabel, quake),
        source: "fallback",
      });
    }
    timelineCache.set(cacheKey, out.data.phases);
    return NextResponse.json({ timeline: out.data.phases, source: "gemini" });
  } catch (err) {
    // 失敗してもアプリを止めない。詳細はサーバーログのみ（内部情報をクライアントに出さない）
    console.error("timeline error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({
      timeline: buildFallback(attrs, destName, hazardLabel, quake),
      source: "fallback",
    });
  }
}
