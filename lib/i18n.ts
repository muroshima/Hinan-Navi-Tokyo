// 画面の文言の多言語辞書（#118）。
// 言語セレクタは以前「タイムラインの生成言語」にしか効いておらず、
// 選んでも画面が何も変わらなかった。日本語が不自由な人に届けるには、
// まず最初に触る画面のことばが切り替わる必要がある。
//
// ja-easy（やさしい日本語）は、漢語を減らし短い文にする。
// 出典表記など法的な表示は原語のまま扱う（CC BY の帰属を訳し崩さない）。
import type { Lang } from "./types";

const ja = {
  appName: "だれでも避難ナビ TOKYO",
  tagline: "ことばで状況を伝えると、あなたが行ける避難所を探します",
  disclaimerShort: "参考情報です。避難の最終判断は自治体の公式情報・指示に従ってください。",
  language: "言語",
  currentLocation: "現在地",
  placeHint: "住所・地名（例: 千代田区神田、新宿駅）",
  set: "設定",
  gps: "GPS",
  gpsLoading: "取得中…",
  consultPlaceholder: "例）雨の日、車椅子の母と避難したい",
  sampleHint: "書きにくいときは、近い例を選んでください",
  search: "避難所をさがす",
  searching: "考えています…",
  researchAgain: "条件を変えて探し直す",
  reasonForRank: "この順位になった理由",
  otherCandidates: "他の候補",
  quakeRiskHere: "いまいる場所の地震リスク",
  dataSource: "データの出典",
  layers: "重ねる",
  route: "ルート",
  showOnMap: "地図",
  pickThis: "ここにする",
  scoreBreakdown: "なぜこの点数？",
  sampleQuake: "地震・延焼",
  sampleStranded: "帰宅困難",
  sampleFlood: "水害・車椅子",
  sampleNight: "夜間・視覚障害",
  extracted: "抽出",
  walkAbout: "徒歩約",
  minutes: "分",
  straightLine: "直線",
} as const;

export type MsgKey = keyof typeof ja;

const jaEasy: Partial<Record<MsgKey, string>> = {
  tagline: "こまっていることを ことばで かいてください。いける ひなんじょを さがします",
  disclaimerShort: "これは めやすです。にげるかどうかは、やくしょの おしらせを みてきめてください。",
  language: "ことば",
  currentLocation: "いまいる ところ",
  placeHint: "じゅうしょ や ばしょの なまえ",
  set: "きめる",
  gpsLoading: "さがしています…",
  consultPlaceholder: "れい）あめの ひ、くるまいすの ははと にげたい",
  sampleHint: "かきにくいときは、にている れいを えらんでください",
  search: "ひなんじょを さがす",
  searching: "かんがえています…",
  researchAgain: "じょうけんを かえて さがす",
  reasonForRank: "なぜ この じゅんばんなのか",
  otherCandidates: "ほかの ばしょ",
  quakeRiskHere: "いまいる ところの じしんの きけん",
  dataSource: "データの でどころ",
  layers: "かさねる",
  route: "みち順",
  showOnMap: "ちず",
  pickThis: "ここに する",
  scoreBreakdown: "なぜ この てんすう？",
  sampleQuake: "じしん・かじ",
  sampleStranded: "いえに かえれない",
  sampleFlood: "みずがい・くるまいす",
  sampleNight: "よる・めが みえにくい",
  walkAbout: "あるいて やく",
  minutes: "ふん",
  straightLine: "まっすぐで",
};

const en: Partial<Record<MsgKey, string>> = {
  appName: "Anyone's Evacuation Navi TOKYO",
  tagline: "Describe your situation in your own words, and we'll find shelters you can actually reach",
  disclaimerShort:
    "For reference only. Always follow official guidance from your local government when deciding to evacuate.",
  language: "Language",
  currentLocation: "Current location",
  placeHint: "Address or place name (e.g. Shinjuku Station)",
  set: "Set",
  gpsLoading: "Locating…",
  consultPlaceholder: "e.g. I need to evacuate with my mother who uses a wheelchair, in the rain",
  sampleHint: "Not sure what to write? Pick a similar example",
  search: "Find shelters",
  searching: "Thinking…",
  researchAgain: "Change conditions and search again",
  reasonForRank: "Why this order",
  otherCandidates: "Other candidates",
  quakeRiskHere: "Earthquake risk where you are",
  dataSource: "Data sources",
  layers: "Layers",
  route: "Route",
  showOnMap: "Map",
  pickThis: "Choose this",
  scoreBreakdown: "Why this score?",
  sampleQuake: "Quake & fire",
  sampleStranded: "Stranded commuter",
  sampleFlood: "Flood & wheelchair",
  sampleNight: "Night & low vision",
  extracted: "extracted by",
  walkAbout: "approx. ",
  minutes: " min walk",
  straightLine: "direct ",
};

const zh: Partial<Record<MsgKey, string>> = {
  appName: "谁都能用的避难导航 TOKYO",
  tagline: "用自己的话描述状况，我们为您寻找真正能到达的避难所",
  disclaimerShort: "仅供参考。是否避难请务必遵循当地政府的官方信息与指示。",
  language: "语言",
  currentLocation: "当前位置",
  placeHint: "地址或地名（例：新宿站）",
  set: "设定",
  gpsLoading: "定位中…",
  consultPlaceholder: "例）下雨天，想和坐轮椅的母亲一起避难",
  sampleHint: "不好描述时，请选择相近的例子",
  search: "寻找避难所",
  searching: "正在思考…",
  researchAgain: "更改条件重新搜索",
  reasonForRank: "为何是这个顺序",
  otherCandidates: "其他候选",
  quakeRiskHere: "当前位置的地震风险",
  dataSource: "数据来源",
  layers: "叠加图层",
  route: "路线",
  showOnMap: "地图",
  pickThis: "选择这里",
  scoreBreakdown: "为何是这个分数？",
  sampleQuake: "地震・蔓延火灾",
  sampleStranded: "无法回家",
  sampleFlood: "水灾・轮椅",
  sampleNight: "夜间・视觉障碍",
  walkAbout: "步行约",
  minutes: "分钟",
  straightLine: "直线",
};

const DICT: Record<Lang, Partial<Record<MsgKey, string>>> = {
  ja,
  "ja-easy": jaEasy,
  en,
  zh,
};

/** 選択言語の文言を引く。未訳のキーは日本語に落とす（表示が消えるより読める方がよい） */
export function tFor(lang: Lang) {
  const d = DICT[lang] ?? ja;
  return (key: MsgKey): string => d[key] ?? ja[key];
}
