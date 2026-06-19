// 利用者属性 × 避難所データ から「行ける避難所」をスコアリングする

import type { EvacFeature, RankedEvac, UserAttrs, HazardKey } from "./types";

const HAZARD_LABEL: Record<HazardKey, string> = {
  flood: "洪水",
  landslide: "土砂災害",
  storm_surge: "高潮",
  earthquake: "地震",
  tsunami: "津波",
  fire: "大規模火事",
  inland_flood: "内水氾濫",
  volcano: "火山",
};

const ATTR_LABEL: { key: keyof UserAttrs; label: string }[] = [
  { key: "wheelchair", label: "車椅子" },
  { key: "elderly", label: "高齢・歩行不安" },
  { key: "stroller", label: "乳幼児連れ" },
  { key: "visual_impairment", label: "視覚障害" },
  { key: "hearing_impairment", label: "聴覚障害" },
  { key: "foreign_language", label: "外国語" },
  { key: "has_caregiver", label: "介助者あり" },
  { key: "ostomate", label: "オストメイト" },
  { key: "severe_care", label: "重度・要介護" },
  { key: "night", label: "夜間" },
  { key: "bad_weather", label: "雨・荒天" },
];

// ハーバサイン距離(km)
export function distanceKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 利用者がバリアフリーを必要とするか
function needsBarrierFree(attrs: UserAttrs): boolean {
  return attrs.wheelchair || attrs.elderly || attrs.stroller || attrs.severe_care;
}

// 単身かつ高ニーズ（介助者なしで車椅子/高齢/重度）
function isAloneHighNeed(attrs: UserAttrs): boolean {
  return !attrs.has_caregiver && (attrs.wheelchair || attrs.elderly || attrs.severe_care);
}

// 1施設をスコアリング
function scoreOne(
  feature: EvacFeature,
  origin: [number, number],
  attrs: UserAttrs
): RankedEvac {
  const p = feature.properties;
  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = 100;

  const d = distanceKm(origin, feature.geometry.coordinates);
  score -= d * 8; // 距離ペナルティ

  // 災害種別の適否(避難場所のみ)
  if (attrs.hazard && p.hazards) {
    if (p.hazards[attrs.hazard]) {
      score += 25;
      reasons.push(`${HAZARD_LABEL[attrs.hazard]}時に避難できる指定場所`);
    } else {
      score -= 60;
      cautions.push(`${HAZARD_LABEL[attrs.hazard]}に対応していない可能性`);
    }
  }

  const bf = needsBarrierFree(attrs);
  if (bf) {
    if (attrs.wheelchair) {
      if (p.a11y.ground_or_elevator) {
        score += 15;
        reasons.push("1階に避難スペース/エレベーター有");
      } else {
        score -= 25;
        cautions.push("段差・階段の可能性(1階/EV情報なし)");
      }
      if (p.a11y.slope) {
        score += 10;
        reasons.push("スロープあり");
      }
      if (p.a11y.wheelchair_toilet) {
        score += 10;
        reasons.push("車椅子対応トイレあり");
      } else {
        cautions.push("車椅子対応トイレ情報なし");
      }
    }
    if (attrs.stroller && p.a11y.ground_or_elevator) {
      score += 8;
      reasons.push("ベビーカーでも入りやすい(1階/EV)");
    }
    if (attrs.elderly && (p.a11y.slope || p.a11y.ground_or_elevator)) {
      score += 6;
      reasons.push("段差が少なく高齢者も移動しやすい");
    }
    // 重度・要介護: 段差なく搬送できる屋内を強く優先
    if (attrs.severe_care) {
      if (p.a11y.ground_or_elevator) {
        score += 12;
        reasons.push("段差なく搬送しやすい(1階/EV)");
      } else {
        score -= 20;
        cautions.push("段差・階段（要介護者の移動が困難）");
      }
    }
  }

  if (attrs.visual_impairment) {
    if (p.a11y.braille) {
      score += 10;
      reasons.push("点字ブロックあり");
    } else {
      cautions.push("点字ブロック情報なし");
    }
  }

  // 屋内で滞在できる指定避難所を優遇（滞在ニーズが高い属性）
  if (
    (attrs.stroller || attrs.elderly || attrs.wheelchair || attrs.severe_care) &&
    p.kind === "center"
  ) {
    score += 5;
    reasons.push("屋内で滞在できる指定避難所");
  }

  // 介助者なし × 高ニーズ: 設備が揃う場所を優先
  if (isAloneHighNeed(attrs)) {
    const full = p.a11y.ground_or_elevator && p.a11y.slope && p.a11y.wheelchair_toilet;
    if (full) {
      score += 8;
      reasons.push("介助者なしでも動きやすい(設備が揃う)");
    } else {
      score -= 6;
      cautions.push("介助者なしには設備がやや不十分");
    }
  }

  // 夜間: 屋内・近さ・安全を重視
  if (attrs.night) {
    if (p.kind === "center") {
      score += 8;
      reasons.push("夜間も屋内で安心の指定避難所");
    } else {
      score -= 8;
      cautions.push("夜間の屋外退避は視界・安全に注意");
    }
    score -= d * 4;
    if (d <= 0.6) reasons.push("夜道が短い近さ");
  }

  // 雨・荒天: 屋内(指定避難所)を優先。屋外の一時退避場所は不利
  if (attrs.bad_weather) {
    if (p.kind === "center") {
      score += 10;
      reasons.push("雨でも濡れにくい屋内の指定避難所");
    } else {
      score -= 12;
      cautions.push("屋外の一時退避場所（雨天時は滞在に不向き）");
    }
    if (needsBarrierFree(attrs)) {
      score -= d * 5;
      if (d <= 0.7) reasons.push("雨でも濡れずに行ける近さ");
    }
  }

  return { feature, distanceKm: d, score, reasons, cautions };
}

/** 避難所候補をスコアリングして上位順に返す */
export function rankEvacuations(
  features: EvacFeature[],
  origin: [number, number],
  attrs: UserAttrs,
  limit = 20
): RankedEvac[] {
  return features
    .map((f) => scoreOne(f, origin, attrs))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// 車椅子対応トイレBFデータから機能別に抽出した座標インデックス
export interface ToiletIndex {
  baby: [number, number][]; // 乳幼児用おむつ交換台
  ostomate: [number, number][]; // オストメイト対応
  largeBed: [number, number][]; // 大型ベッド
  call: [number, number][]; // 非常用呼び出しボタン
}

function nearestMeters(coord: [number, number], list: [number, number][]): number | null {
  let min = Infinity;
  for (const c of list) {
    const d = distanceKm(coord, c);
    if (d < min) min = d;
  }
  return isFinite(min) ? Math.round(min * 1000) : null;
}

/**
 * 利用者属性に応じて、各避難所の近くにある「必要な設備つきトイレ」を
 * 車椅子対応トイレBFデータから紐づけて優遇・表示する。
 * - 乳幼児連れ → おむつ替え台 / オストメイト → オストメイト対応
 * - 重度・要介護 → 大型ベッド / 介助者なし高ニーズ → 非常用ボタン
 */
export function enrichToiletNeeds(
  ranked: RankedEvac[],
  idx: ToiletIndex,
  attrs: UserAttrs
): RankedEvac[] {
  const want = {
    baby: attrs.stroller,
    ostomate: attrs.ostomate,
    largeBed: attrs.severe_care,
    call: isAloneHighNeed(attrs),
  };
  if (!want.baby && !want.ostomate && !want.largeBed && !want.call) return ranked;

  const enriched = ranked.map((r) => {
    const c = r.feature.geometry.coordinates;
    const reasons = [...r.reasons];
    let score = r.score;
    const add: Partial<RankedEvac> = {};

    if (want.baby) {
      const m = nearestMeters(c, idx.baby);
      add.babyChangeM = m;
      if (m !== null && m <= 300) {
        reasons.unshift(`🍼 徒歩約${m}mにおむつ替え台`);
        score += 6;
      }
    }
    if (want.ostomate) {
      const m = nearestMeters(c, idx.ostomate);
      add.ostomateM = m;
      if (m !== null && m <= 400) {
        reasons.unshift(`🚻 徒歩約${m}mにオストメイト対応トイレ`);
        score += 6;
      }
    }
    if (want.largeBed) {
      const m = nearestMeters(c, idx.largeBed);
      add.largeBedM = m;
      if (m !== null && m <= 500) {
        reasons.unshift(`🛏 徒歩約${m}mに大型ベッド付きトイレ`);
        score += 6;
      }
    }
    if (want.call) {
      const m = nearestMeters(c, idx.call);
      add.callM = m;
      if (m !== null && m <= 400) {
        reasons.unshift(`🆘 徒歩約${m}mに非常用ボタン付きトイレ`);
        score += 4;
      }
    }
    return { ...r, ...add, reasons, score };
  });
  return enriched.sort((a, b) => b.score - a.score);
}

// 当事者の意思決定を支援する説明
export interface Decision {
  summary: string; // なぜ1位か
  nearerRejected: { name: string; distanceKm: number; reason: string } | null;
}

function activeAttrLabels(attrs: UserAttrs): string[] {
  const xs = ATTR_LABEL.filter((a) => attrs[a.key]).map((a) => a.label);
  if (attrs.hazard) xs.push(`${HAZARD_LABEL[attrs.hazard]}を想定`);
  return xs;
}

/**
 * 1位の根拠説明と、「より近いのに見送った候補とその理由」を生成する。
 */
export function explainDecision(
  features: EvacFeature[],
  origin: [number, number],
  attrs: UserAttrs,
  ranked: RankedEvac[]
): Decision | null {
  const top = ranked[0];
  if (!top) return null;

  const attrText = activeAttrLabels(attrs).join("・") || "一般";
  const r = top.reasons.slice(0, 3).join("、");
  const summary =
    `あなたの状況（${attrText}）に最も適した避難先です。` +
    (r ? `${r}。` : "") +
    `現在地から約${top.distanceKm.toFixed(1)}km。`;

  let nearerRejected: Decision["nearerRejected"] = null;
  let best: { d: number; name: string; reason: string } | null = null;
  for (const f of features) {
    const d = distanceKm(origin, f.geometry.coordinates);
    if (d >= top.distanceKm - 0.05) continue;
    const s = scoreOne(f, origin, attrs);
    if (s.score >= top.score || s.cautions.length === 0) continue;
    if (!best || d < best.d) {
      best = { d, name: f.properties.name, reason: s.cautions[0] };
    }
  }
  if (best) {
    nearerRejected = { name: best.name, distanceKm: best.d, reason: best.reason };
  }

  return { summary, nearerRejected };
}

export { HAZARD_LABEL, activeAttrLabels };
