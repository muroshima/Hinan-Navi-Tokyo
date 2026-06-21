// 避難所/避難場所・利用者属性・ランキング結果の型定義

export type EvacKind = "center" | "area"; // center=指定避難所(滞在) / area=指定緊急避難場所(一時退避)

export interface A11y {
  ground_or_elevator: boolean; // 1階に避難スペース or エレベーター有
  slope: boolean; // スロープ等
  braille: boolean; // 点字ブロック
  wheelchair_toilet: boolean; // 車椅子使用者対応トイレ
}

// 避難場所(area)のみ災害種別ごとの適否
export interface Hazards {
  flood: boolean;
  landslide: boolean;
  storm_surge: boolean;
  earthquake: boolean;
  tsunami: boolean;
  fire: boolean;
  inland_flood: boolean;
  volcano: boolean;
}

export type HazardKey = keyof Hazards;

export interface EvacProps {
  id: string;
  name: string;
  kind: EvacKind;
  city: string;
  address: string;
  a11y: A11y;
  hazards: Hazards | null;
  note: string;
  agingRate?: number | null; // 市区町村の高齢化率(%) ※文脈情報
  cityPop?: number | null; // 市区町村の総人口
}

export interface EvacFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: EvacProps;
}

export interface EvacCollection {
  type: "FeatureCollection";
  features: EvacFeature[];
}

// Claudeが自然文から抽出する利用者の状況属性
export interface UserAttrs {
  wheelchair: boolean; // 車椅子
  elderly: boolean; // 高齢・歩行に不安
  stroller: boolean; // ベビーカー・乳幼児連れ
  visual_impairment: boolean; // 視覚障害
  hearing_impairment: boolean; // 聴覚障害
  foreign_language: boolean; // 日本語が不自由
  has_caregiver: boolean; // 介助者がいる
  ostomate: boolean; // オストメイト（人工肛門・ストーマ）
  severe_care: boolean; // 寝たきり・重度・要介護（大型ベッド等が必要）
  night: boolean; // 夜間の避難
  bad_weather: boolean; // 雨・荒天（屋内/近距離を優先）
  hazard: HazardKey | null; // 想定している災害(あれば)
}

export const DEFAULT_ATTRS: UserAttrs = {
  wheelchair: false,
  elderly: false,
  stroller: false,
  visual_impairment: false,
  hearing_impairment: false,
  foreign_language: false,
  has_caregiver: false,
  ostomate: false,
  severe_care: false,
  night: false,
  bad_weather: false,
  hazard: null,
};

// スコア内訳（説明可能性: なぜその点数か）
export type ScoreCategory =
  | "base" // 基準点
  | "distance" // 距離ペナルティ
  | "hazard" // 想定災害への適否
  | "barrier_free" // バリアフリー設備
  | "facility" // 屋内/設備の充実
  | "context"; // 夜間・天候など状況

export interface ScoreFactor {
  label: string; // 例: "車椅子対応トイレ"
  delta: number; // 加減点(正=加点 / 負=減点)
  category: ScoreCategory;
}

// 回答の出力言語（やさしい日本語・日本語・英語・中文）
// 言語コードの単一ソース。Lang型・Zod schema・BCP47・LANGS はすべてこれに従う
export const LANG_CODES = ["ja-easy", "ja", "en", "zh"] as const;
export type Lang = (typeof LANG_CODES)[number];

export const LANGS: { code: Lang; label: string }[] = [
  { code: "ja", label: "日本語" },
  { code: "ja-easy", label: "やさしい日本語" },
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
];

// マイ・タイムライン（局面別の避難行動。/api/timeline が生成）
export interface TimelinePhase {
  phase: string; // 局面名（例: 避難開始）
  level: string; // 対応する警戒レベル/時点
  actions: string[]; // その局面の具体的な行動
}

// ランキング結果(避難所 + スコアと理由)
export interface RankedEvac {
  feature: EvacFeature;
  distanceKm: number;
  score: number;
  factors: ScoreFactor[]; // スコアの加減点内訳（可視化用）
  reasons: string[]; // おすすめ理由
  cautions: string[]; // 注意・不適合点
  babyChangeM?: number | null; // 最寄りのおむつ替え台までの距離(m) ※乳幼児連れ時
  ostomateM?: number | null; // 最寄りオストメイト対応トイレ(m)
  largeBedM?: number | null; // 最寄り大型ベッド付きトイレ(m)
  callM?: number | null; // 最寄り非常用ボタン付きトイレ(m)
  walkM?: number | null; // 実経路の徒歩距離(m) ※OSRM
  walkMin?: number | null; // 実経路の徒歩所要(分)
}
