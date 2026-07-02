// 浸水回避ルーティング(#38)のクライアント側解析。
// public/data/flood_grid.json(粗いグリッド: セル→[最大浸水深, 地盤高])に対し、
// OSRM経路の座標列をサンプルして「浸水想定域の通過・最大浸水深」を判定する。
// OSRMは重み付け不可のため、複数の代替経路の中から浸水曝露が最小の経路を選ぶ形で回避する。

export interface FloodGrid {
  cell: number; // 1辺(度)
  cells: Record<string, [number, number | null]>; // "iLat,iLon" -> [最大浸水深m, 地盤高m|null]
}

export interface RouteFloodStats {
  maxDepthM: number; // 経路上セルの最大浸水深(0=浸水域を通らない)
  floodedPoints: number; // 浸水域(深さ>0)に入ったサンプル点数
  totalPoints: number; // サンプル総点数
  floodedRatio: number; // 浸水域通過の割合(0..1)
}

// 経路(座標列 [lng,lat][])の浸水曝露を集計。
// 連続する点が同一セルに入ることが多いため、直前セルの結果をキャッシュして
// セルが変わったときだけ grid を参照する(Map参照・文字列キー生成の無駄を削減)。
export function analyzeRoute(coords: [number, number][], grid: FloodGrid): RouteFloodStats {
  let maxDepthM = 0;
  let floodedPoints = 0;
  let prevIl: number | null = null;
  let prevIo: number | null = null;
  let prevDepth = 0;
  for (const [lng, lat] of coords) {
    const il = Math.round(lat / grid.cell);
    const io = Math.round(lng / grid.cell);
    let d: number;
    if (il === prevIl && io === prevIo) {
      d = prevDepth; // 同一セル: 参照を省略
    } else {
      const c = grid.cells[`${il},${io}`];
      d = c ? c[0] : 0;
      prevIl = il;
      prevIo = io;
      prevDepth = d;
    }
    if (d > 0) {
      floodedPoints += 1;
      if (d > maxDepthM) maxDepthM = d;
    }
  }
  const totalPoints = coords.length;
  return {
    maxDepthM: Math.round(maxDepthM * 10) / 10,
    floodedPoints,
    totalPoints,
    floodedRatio: totalPoints ? floodedPoints / totalPoints : 0,
  };
}

export interface RouteInfo {
  coordinates: [number, number][];
  distM: number | null;
  durSec: number | null;
}

export interface AnalyzedRoute extends RouteInfo {
  flood: RouteFloodStats;
}

// 複数経路を解析し、浸水曝露が少ない順→距離が短い順で並べる。
// 先頭が「最も安全に近い(浸水を避けられる)推奨経路」。
export function pickSafestRoute(routes: RouteInfo[], grid: FloodGrid | null): {
  ranked: AnalyzedRoute[];
  recommended: AnalyzedRoute | null;
} {
  const analyzed: AnalyzedRoute[] = routes.map((r) => ({
    ...r,
    flood: grid
      ? analyzeRoute(r.coordinates, grid)
      : { maxDepthM: 0, floodedPoints: 0, totalPoints: r.coordinates.length, floodedRatio: 0 },
  }));
  const ranked = [...analyzed].sort((a, b) => {
    // まず浸水曝露(最大深さ→通過割合)、同等なら距離で比較
    if (a.flood.maxDepthM !== b.flood.maxDepthM) return a.flood.maxDepthM - b.flood.maxDepthM;
    if (a.flood.floodedRatio !== b.flood.floodedRatio) return a.flood.floodedRatio - b.flood.floodedRatio;
    return (a.distM ?? Infinity) - (b.distM ?? Infinity);
  });
  return { ranked, recommended: ranked[0] ?? null };
}
