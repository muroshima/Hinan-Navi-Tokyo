// MapLibre が参照する外部ホストの単一の真実。
// next.config.ts(CSP の connect-src) と components/MapView.tsx(タイル/glyphs/ベクタのURL) の
// 双方から参照し、片方だけ更新して CSP 違反になる事故を防ぐ(#66 レビュー指摘)。

export const OSM_TILE_HOST = "https://tile.openstreetmap.org"; // ベース地図(raster)
export const GSI_HAZARD_HOST = "https://disaportaldata.gsi.go.jp"; // 国交省ハザード(raster)
export const AWS_DEM_HOST = "https://s3.amazonaws.com"; // AWS Terrarium DEM(raster/3D地形)
export const MAPLIBRE_GLYPHS_HOST = "https://demotiles.maplibre.org"; // ラベル用glyphs(pbf)
export const PLATEAU_MVT_HOST = "https://indigo-lab.github.io"; // PLATEAU建物MVT(pbf)

// ⚠️ CSP用: MapLibre GL v5 は**ラスタタイルも Fetch API で取得**する(実測でOSMタイルが
//   connect-src 違反になることを確認)。よって glyphs/ベクタだけでなく全タイルホストを
//   connect-src に載せる。img-src は data:/blob: のみで足りる(タイルは fetch→canvas 描画で
//   <img>にはならない)。
export const MAP_CONNECT_HOSTS = [
  OSM_TILE_HOST,
  GSI_HAZARD_HOST,
  AWS_DEM_HOST,
  MAPLIBRE_GLYPHS_HOST,
  PLATEAU_MVT_HOST,
];
