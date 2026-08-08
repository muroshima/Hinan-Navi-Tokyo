// 地点の地震リスクを引く（#106）。
// 水害は「どこが浸かるか」が標高で決まるが、地震のリスクは建て詰まり方で決まるため、
// 東京都が町丁目単位で公表する地域危険度（建物倒壊・火災・総合）と、
// 想定地震の250mメッシュ（計測震度・液状化）を地点に当てて判断材料にする。

import type { QuakeGrid, QuakeRisk, QuakeRiskFeature } from "./types";

// 危険度ランクの意味（東京都は順位に基づく相対評価で1〜5に区分している）
export const RANK_LABEL: Record<number, string> = {
  1: "低い",
  2: "やや低い",
  3: "中程度",
  4: "高い",
  5: "特に高い",
};

// 液状化 PL値 の目安（建築基準等で用いられる区分）
export function liquefactionLabel(pl: number): string {
  if (pl > 15) return "液状化の危険度が極めて高い";
  if (pl > 5) return "液状化の危険度が高い";
  if (pl > 0) return "液状化の可能性がある";
  return "液状化の可能性は低い";
}

// 計測震度 → 気象庁震度階級
export function shindoLabel(v: number): string {
  if (v >= 6.5) return "震度7";
  if (v >= 6.0) return "震度6強";
  if (v >= 5.5) return "震度6弱";
  if (v >= 5.0) return "震度5強";
  if (v >= 4.5) return "震度5弱";
  return "震度4以下";
}

// --- 町丁目ポリゴンの索引 -------------------------------------------------------
// 5,192件を毎回総当たりすると重いので、bboxを前計算して矩形で足切りする
type Ring = GeoJSON.Position[];
type Polygon = Ring[]; // [0]=外周, [1..]=穴

interface IndexedFeature {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  polygons: Polygon[];
  props: QuakeRiskFeature["properties"];
}

export interface QuakeRiskIndex {
  items: IndexedFeature[];
}

/** 町丁目危険度の FeatureCollection から検索用インデックスを作る */
export function buildQuakeRiskIndex(features: QuakeRiskFeature[]): QuakeRiskIndex {
  const items: IndexedFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    // Polygon と MultiPolygon を「ポリゴンの配列」に正規化して以降の扱いを揃える
    const polygons: Polygon[] =
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const rings of polygons) {
      for (const ring of rings) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!Number.isFinite(minX)) continue;
    items.push({ minX, minY, maxX, maxY, polygons, props: f.properties });
  }
  return { items };
}

// リング内かどうか（ray casting）
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 最初のリングが外周、以降は穴（GeoJSON の規約）
function pointInPolygon(x: number, y: number, rings: Polygon): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(x, y, rings[i])) return false;
  }
  return true;
}

/** 地点を含む町丁目の危険度を返す（無ければ null） */
export function lookupChome(
  point: [number, number],
  index: QuakeRiskIndex | null
): QuakeRiskFeature["properties"] | null {
  if (!index) return null;
  const [x, y] = point;
  for (const it of index.items) {
    if (x < it.minX || x > it.maxX || y < it.minY || y > it.maxY) continue;
    for (const poly of it.polygons) {
      if (pointInPolygon(x, y, poly)) return it.props;
    }
  }
  return null;
}

/** 250mメッシュ格子から想定震度・液状化を引く */
export function lookupGrid(
  point: [number, number],
  grid: QuakeGrid | null
): { shindo: number | null; pl: number | null; sink: number | null } {
  if (!grid) return { shindo: null, pl: null, sink: null };
  const key = `${Math.floor(point[1] / grid.cellLat)},${Math.floor(point[0] / grid.cellLon)}`;
  const v = grid.cells[key];
  if (!v) return { shindo: null, pl: null, sink: null };
  return { shindo: v[0], pl: v[1], sink: v[2] };
}

/** 地点の地震リスクをまとめて返す */
export function lookupQuakeRisk(
  point: [number, number],
  index: QuakeRiskIndex | null,
  grid: QuakeGrid | null
): QuakeRisk {
  const chome = lookupChome(point, index);
  const g = lookupGrid(point, grid);
  return {
    city: chome?.city ?? null,
    chome: chome?.chome ?? null,
    buildingRank: chome?.buildingRank ?? null,
    fireRank: chome?.fireRank ?? null,
    totalRank: chome?.totalRank ?? null,
    shindo: g.shindo,
    liquefactionPL: g.pl,
    subsidenceM: g.sink,
  };
}

/**
 * 避難経路上の延焼・液状化リスクを評価する。
 * 地震では「避難先が安全か」だけでなく「そこへ行き着けるか」が生死を分ける。
 * 木造密集地を貫く経路は、延焼と建物倒壊による道路閉塞の両方に晒される。
 */
export interface QuakeRouteAdvisory {
  maxFireRank: number | null;
  maxBuildingRank: number | null;
  maxPL: number | null;
  worstChome: string | null; // 最も火災危険度が高い通過町丁目
}

export function analyzeQuakeRoute(
  coordinates: [number, number][],
  index: QuakeRiskIndex | null,
  grid: QuakeGrid | null
): QuakeRouteAdvisory | null {
  if (coordinates.length === 0 || (!index && !grid)) return null;
  // 経路の点は密なので、およそ100m間隔に間引いて判定コストを抑える
  const sampled: [number, number][] = [];
  let last: [number, number] | null = null;
  for (const c of coordinates) {
    if (!last || Math.abs(c[0] - last[0]) > 0.001 || Math.abs(c[1] - last[1]) > 0.001) {
      sampled.push(c);
      last = c;
    }
  }
  if (sampled.length === 0) sampled.push(coordinates[0]);

  let maxFireRank: number | null = null;
  let maxBuildingRank: number | null = null;
  let maxPL: number | null = null;
  let worstChome: string | null = null;
  for (const p of sampled) {
    const c = lookupChome(p, index);
    if (c) {
      if (maxFireRank === null || c.fireRank > maxFireRank) {
        maxFireRank = c.fireRank;
        worstChome = `${c.city}${c.chome}`;
      }
      if (maxBuildingRank === null || c.buildingRank > maxBuildingRank) {
        maxBuildingRank = c.buildingRank;
      }
    }
    const g = lookupGrid(p, grid);
    if (g.pl !== null && (maxPL === null || g.pl > maxPL)) maxPL = g.pl;
  }
  if (maxFireRank === null && maxPL === null) return null;
  return { maxFireRank, maxBuildingRank, maxPL, worstChome };
}
