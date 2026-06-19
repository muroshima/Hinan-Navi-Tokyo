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
  return attrs.wheelchair || attrs.elderly || attrs.stroller;
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
  }

  if (attrs.visual_impairment) {
    if (p.a11y.braille) {
      score += 10;
      reasons.push("点字ブロックあり");
    } else {
      cautions.push("点字ブロック情報なし");
    }
  }

  if ((attrs.stroller || attrs.elderly || attrs.wheelchair) && p.kind === "center") {
    score += 5;
    reasons.push("屋内で滞在できる指定避難所");
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

// 当事者の意思決定を支援する説明
export interface Decision {
  summary: string; // なぜ1位か
  // より近いのに薦めなかった候補（あれば）
  nearerRejected: { name: string; distanceKm: number; reason: string } | null;
}

function activeAttrLabels(attrs: UserAttrs): string[] {
  const xs = ATTR_LABEL.filter((a) => attrs[a.key]).map((a) => a.label);
  if (attrs.hazard) xs.push(`${HAZARD_LABEL[attrs.hazard]}を想定`);
  return xs;
}

/**
 * 1位の根拠説明と、「より近いのに見送った候補とその理由」を生成する。
 * 既存サービスの“最寄り順リスト”との差別化（当事者の意思決定支援）。
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

  // より近いのに見送った候補: topより明確に近く、注意点があり、スコアが低いもの
  let nearerRejected: Decision["nearerRejected"] = null;
  let best: { d: number; name: string; reason: string } | null = null;
  for (const f of features) {
    const d = distanceKm(origin, f.geometry.coordinates);
    if (d >= top.distanceKm - 0.05) continue; // topより近いものだけ
    const s = scoreOne(f, origin, attrs);
    if (s.score >= top.score || s.cautions.length === 0) continue; // 見送り理由が要る
    if (!best || d < best.d) {
      best = { d, name: f.properties.name, reason: s.cautions[0] };
    }
  }
  if (best) {
    nearerRejected = { name: best.name, distanceKm: best.d, reason: best.reason };
  }

  return { summary, nearerRejected };
}

export { HAZARD_LABEL };
