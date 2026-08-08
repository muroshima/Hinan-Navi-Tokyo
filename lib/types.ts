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
  agingRate?: number | null; // 高齢化率(%) ※文脈情報。agingLevelで粒度を示す
  agingLevel?: "chome" | "city" | null; // chome=町丁目粒度(BQ空間結合) / city=市区町村fallback
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

// LLM(Vertex AI Gemini)が自然文から抽出する利用者の状況属性
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
  outside: boolean; // 外出中（自宅から離れている＝地震では帰宅困難者になり得る）
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
  outside: false,
  hazard: null,
};

// スコア内訳（説明可能性: なぜその点数か）
export type ScoreCategory =
  | "base" // 基準点
  | "distance" // 距離ペナルティ
  | "hazard" // 想定災害への適否
  | "barrier_free" // バリアフリー設備
  | "facility" // 屋内/設備の充実
  | "context" // 夜間・天候など状況
  | "quake"; // 地震リスク（延焼・液状化・想定震度）

export interface ScoreFactor {
  label: string; // 例: "車椅子対応トイレ"
  delta: number; // 加減点(正=加点 / 負=減点)
  category: ScoreCategory;
}

// 回答の出力言語（やさしい日本語・日本語・英語・中文）
// 言語コードの単一ソース。Lang型・Zod schema・BCP47・LANGS はすべてこれに従う
export const LANG_CODES = ["ja", "ja-easy", "en", "zh"] as const;
export type Lang = (typeof LANG_CODES)[number];

// ラベルは Record<Lang> で型固定し、LANG_CODES から LANGS を生成（漏れ・順序ズレを型で検出）
const LANG_LABELS: Record<Lang, string> = {
  ja: "日本語",
  "ja-easy": "やさしい日本語",
  en: "English",
  zh: "中文",
};
export const LANGS: { code: Lang; label: string }[] = LANG_CODES.map((code) => ({
  code,
  label: LANG_LABELS[code],
}));

// 生活継続レイヤー（給水拠点・公衆Wi-Fi）
export type LifelineKind = "water" | "wifi";
export interface LifelineProps {
  id: string;
  kind: LifelineKind;
  name: string;
  category?: string; // 給水: 種別
  capacity?: number | null; // 給水: 確保水量(立方メートル)
  address?: string;
}
export type LifelineFeature = GeoJSON.Feature<GeoJSON.Point, LifelineProps>;

// バス停（都営バスGTFS）
export interface BusStopProps {
  id: string;
  name: string;
  wheelchair: boolean; // 車椅子対応(GTFS wheelchair_boarding=1)
}
export type BusStopFeature = GeoJSON.Feature<GeoJSON.Point, BusStopProps>;

// バリアフリー施設（「だれでも東京」。避難経路上で立ち寄れる施設）
export interface AccessibleFacilityProps {
  id: string;
  category: string; // 宿泊/買い物/レジャー/飲食/交通/公園/公共施設
  name: string;
  address?: string;
  url?: string;
  accessible_toilet: boolean; // だれでもトイレ
  ostomate: boolean; // オストメイト対応トイレ
  elevator: boolean; // エレベーター
  slope: boolean; // 出入口スロープ
  braille_block: boolean; // 点字ブロック
  wheelchair_parking: boolean; // 車いす専用駐車場
  diaper_change: boolean; // おむつ交換台
  assist_dog_toilet: boolean; // 補助犬専用トイレ
}
export type AccessibleFacilityFeature = GeoJSON.Feature<GeoJSON.Point, AccessibleFacilityProps>;

// 帰宅困難者向け 都立の一時滞在施設（避難所ではなく一時待機先）
export interface TempStayProps {
  id: string;
  name: string;
  address?: string;
}
export type TempStayFeature = GeoJSON.Feature<GeoJSON.Point, TempStayProps>;

// 地震に関する地域危険度測定調査(第9回)の町丁目ポリゴン。ランクは1(低)〜5(高)
export interface QuakeRiskProps {
  city: string;
  chome: string;
  buildingRank: number; // 建物倒壊危険度
  fireRank: number; // 火災危険度（延焼のしやすさ）
  totalRank: number; // 総合危険度
}
export type QuakeRiskFeature = GeoJSON.Feature<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  QuakeRiskProps
>;

// 想定地震の250mメッシュ格子（計測震度・液状化）。cells の値は [震度, PL値, 沈下量m]
export interface QuakeGrid {
  scenario: string; // 想定シナリオ名（例: 都心南部直下地震）
  cellLat: number;
  cellLon: number;
  cells: Record<string, [number | null, number | null, number | null]>;
}

// 地域危険度の表示指標。町丁目ポリゴンを危険度ランクで塗り分ける
export type QuakeRiskLayer = "totalRank" | "buildingRank" | "fireRank";
// 格子で見せる指標。想定震度と液状化はメッシュのカバー範囲が違うため分けて扱う
export type QuakeGridLayer = "shindo" | "liquefaction";

// ある地点の地震リスク（町丁目の危険度 + 格子の想定震度・液状化）
export interface QuakeRisk {
  city: string | null;
  chome: string | null;
  buildingRank: number | null;
  fireRank: number | null;
  totalRank: number | null;
  shindo: number | null; // 計測震度（例 6.13）
  liquefactionPL: number | null; // 液状化危険度 PL値
  subsidenceM: number | null; // 想定沈下量(m)
}

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
  quake?: QuakeRisk | null; // 避難先の地震リスク ※想定災害が地震・火災のとき
}
