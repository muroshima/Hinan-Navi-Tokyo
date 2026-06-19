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

// ハーバサイン距離(km)
export function distanceKm(
  a: [number, number],
  b: [number, number]
): number {
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

/**
 * 避難所候補をスコアリングして上位順に返す。
 * スコア = バリアフリー適合 + ハザード回避 - 距離ペナルティ
 */
export function rankEvacuations(
  features: EvacFeature[],
  origin: [number, number],
  attrs: UserAttrs,
  limit = 20
): RankedEvac[] {
  const bf = needsBarrierFree(attrs);

  const ranked: RankedEvac[] = features.map((feature) => {
    const p = feature.properties;
    const reasons: string[] = [];
    const cautions: string[] = [];
    let score = 100;

    const d = distanceKm(origin, feature.geometry.coordinates);
    // 距離ペナルティ(1kmあたり-8、近いほど高い)
    score -= d * 8;

    // 災害種別の適否(避難場所のみ)
    if (attrs.hazard && p.hazards) {
      if (p.hazards[attrs.hazard]) {
        score += 25;
        reasons.push(`${HAZARD_LABEL[attrs.hazard]}時に避難できる指定場所`);
      } else {
        score -= 60;
        cautions.push(`${HAZARD_LABEL[attrs.hazard]}には対応していない可能性`);
      }
    }

    // バリアフリー適合
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

    // 視覚障害 → 点字ブロック
    if (attrs.visual_impairment) {
      if (p.a11y.braille) {
        score += 10;
        reasons.push("点字ブロックあり");
      } else {
        cautions.push("点字ブロック情報なし");
      }
    }

    // 滞在が必要そう(乳幼児/高齢/車椅子)なら指定避難所(center)を優遇
    if ((attrs.stroller || attrs.elderly || attrs.wheelchair) && p.kind === "center") {
      score += 5;
      reasons.push("屋内で滞在できる指定避難所");
    }

    return { feature, distanceKm: d, score, reasons, cautions };
  });

  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

export { HAZARD_LABEL };
