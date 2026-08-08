"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  EvacFeature,
  RankedEvac,
  HazardKey,
  LifelineKind,
  LifelineFeature,
  BusStopFeature,
  AccessibleFacilityFeature,
  TempStayFeature,
  QuakeGrid,
  QuakeGridLayer,
  QuakeRiskFeature,
  QuakeRiskLayer,
} from "@/lib/types";
import { RANK_LABEL } from "@/lib/quakeRisk";
import type { RouteRisk } from "@/lib/floodRoute";
import {
  OSM_TILE_HOST,
  GSI_HAZARD_HOST,
  AWS_DEM_HOST,
  MAPLIBRE_GLYPHS_HOST,
  PLATEAU_MVT_HOST,
} from "@/lib/mapHosts";

const TOKYO: [number, number] = [139.7528, 35.6852];

// 国交省ハザードマップポータルのラスタータイル（疎通確認済みの層のみ）
const HAZARD_TILES: Partial<Record<HazardKey, { url: string; label: string }>> = {
  flood: {
    url: `${GSI_HAZARD_HOST}/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png`,
    label: "洪水浸水想定",
  },
  storm_surge: {
    url: `${GSI_HAZARD_HOST}/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png`,
    label: "高潮浸水想定",
  },
  tsunami: {
    url: `${GSI_HAZARD_HOST}/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png`,
    label: "津波浸水想定",
  },
  landslide: {
    url: `${GSI_HAZARD_HOST}/raster/05_kyukeishakeikaikuiki/{z}/{x}/{y}.png`,
    label: "土砂災害(急傾斜地)警戒区域",
  },
};

const HAZARD_KEYS = Object.keys(HAZARD_TILES) as HazardKey[];

// APIキー不要の OSM ラスタースタイル
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  // ラベル(symbol)描画にはglyphsが必須。APIキー不要のMapLibreデモフォントを使用
  // (日本語=CJKはMap側のlocalIdeographFontFamilyでローカル描画)
  glyphs: `${MAPLIBRE_GLYPHS_HOST}/font/{fontstack}/{range}.pbf`,
  sources: {
    osm: {
      type: "raster",
      tiles: [`${OSM_TILE_HOST}/{z}/{x}/{y}.png`],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

interface Props {
  all: EvacFeature[]; // 全避難所(背景表示)
  ranked: RankedEvac[]; // 絞り込み結果(強調)
  origin: [number, number] | null;
  hazards?: HazardKey[]; // 表示するハザードレイヤ
  threeD?: boolean; // 3D地形(坂・起伏)表示
  lifeline?: LifelineFeature[]; // 生活継続レイヤー(給水/Wi-Fi)
  lifelineShow?: LifelineKind[]; // 表示する生活継続レイヤー種別
  buildings3d?: boolean; // PLATEAU建物3D（垂直避難先を高さで色分け）
  busStops?: BusStopFeature[]; // 都営バス停
  showBusStops?: boolean; // バス停レイヤ表示
  accessibleFacilities?: AccessibleFacilityFeature[]; // バリアフリー施設(だれでも東京)
  showAccessible?: boolean; // バリアフリー施設レイヤ表示
  tempStay?: TempStayFeature[]; // 帰宅困難者向け 都立一時滞在施設
  showTempStay?: boolean; // 一時滞在施設レイヤ表示
  routeLine?: { coordinates: [number, number][]; risk: RouteRisk } | null; // 推奨避難所への徒歩経路(#38, #110)
  quakeRisk?: QuakeRiskFeature[]; // 地震に関する地域危険度(町丁目)(#106)
  quakeRiskLayer?: QuakeRiskLayer | null; // 表示する危険度指標（null=非表示）
  quakeGrid?: QuakeGrid | null; // 想定震度・液状化の250mメッシュ
  quakeGridLayer?: QuakeGridLayer | null; // 表示する格子指標（null=非表示）
  // 結果リストから選ばれた避難所へ寄せる(#107)。seq は同じ避難所を選び直したときも再実行させるための連番
  focus?: { id: string; coordinates: [number, number]; seq: number } | null;
}

// 危険度ランク1〜5の色（黄→赤。ランク1は淡く、面が地図を覆いすぎないようにする）
const RANK_COLORS = ["#fef9c3", "#fde68a", "#fb923c", "#ef4444", "#991b1b"];

// 指標(総合/建物倒壊/火災)の切替は、データを持ち替えず paint 式だけ差し替える。
// 3指標とも properties に載せてあるので setData の再構築(5,192ポリゴン)が起きない
function rankColorExpr(key: QuakeRiskLayer): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", key],
    1, RANK_COLORS[0],
    2, RANK_COLORS[1],
    3, RANK_COLORS[2],
    4, RANK_COLORS[3],
    5, RANK_COLORS[4],
    "#e5e7eb",
  ];
}

function rankOpacityExpr(key: QuakeRiskLayer): maplibregl.ExpressionSpecification {
  // ランクが高いほど濃く。低ランクは地図が読めるよう薄くする
  return ["interpolate", ["linear"], ["get", key], 1, 0.18, 3, 0.4, 5, 0.6];
}

// 計測震度 5.0(震度5強)〜6.5(震度7)
const SHINDO_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], ["get", "s"],
  5.0, "#fef3c7",
  5.5, "#fdba74",
  6.0, "#f97316",
  6.5, "#b91c1c",
];

// 液状化 PL値 0〜30（PL>15 で危険度が極めて高いとされる）
const LIQ_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], ["get", "p"],
  0, "#e0f2fe",
  5, "#7dd3fc",
  15, "#2563eb",
  30, "#4c1d95",
];

// 避難経路の線幅(#110)。引きでも寄りでも追えるようズームに連動させる
const ROUTE_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  10, 4,
  14, 6,
  17, 10,
];
// 縁取りは本線より一回り太くする
const ROUTE_CASING_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  10, 7,
  14, 10,
  17, 15,
];

// 危険な経路の破線パターン。視差の軽減が有効な環境ではこの形のまま静止させる
const DASH_STATIC: [number, number] = [2, 1.5];

// 破線を少しずつずらして「流れる」ように見せる連番（marching ants）。
// 点滅(フラッシュ)は採用しない: WCAG 2.3.1 の光過敏性発作リスクがあり、
// 災害時に長く見続ける画面では疲労も大きい。流れる破線なら進行方向も示せる。
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];
// 1コマの表示時間(ms)。滑らかに見えて描画負荷も低い程度に間引く
const DASH_FRAME_MS = 70;

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ポップアップにデータ由来の文字列を差し込む際のHTMLエスケープ
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

export default function MapView({
  all,
  ranked,
  origin,
  hazards = [],
  threeD = false,
  lifeline = [],
  lifelineShow = [],
  buildings3d = false,
  busStops = [],
  showBusStops = false,
  accessibleFacilities = [],
  showAccessible = false,
  tempStay = [],
  showTempStay = false,
  routeLine = null,
  quakeRisk = [],
  quakeRiskLayer = null,
  quakeGrid = null,
  quakeGridLayer = null,
  focus = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // load完了をstateで管理し、各反映effectの依存に含める
  // (loadより先にデータが届いても、loaded反転で確実に再反映される)
  const [loaded, setLoaded] = useState(false);
  // 端末の「視差の軽減」設定。有効なら経路の破線アニメーションを止める(#110)
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(mq.matches);
    update();
    // 旧Safari(addEventListener非対応)は addListener にフォールバック
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);

  // 初期化（マウント時に1回）＋アンマウントで破棄
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: TOKYO,
      zoom: 11,
      localIdeographFontFamily: "sans-serif", // CJK(日本語)ラベルをローカルフォントで描画
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => {
      // ハザードレイヤ（OSMの上、ポイントの下）。初期は非表示
      for (const key of HAZARD_KEYS) {
        const h = HAZARD_TILES[key]!;
        map.addSource(`hz-${key}`, {
          type: "raster",
          tiles: [h.url],
          tileSize: 256,
          attribution: "ハザードマップポータルサイト(国土交通省)",
        });
        map.addLayer({
          id: `hz-${key}`,
          type: "raster",
          source: `hz-${key}`,
          layout: { visibility: "none" },
          paint: { "raster-opacity": 0.55 },
        });
      }
      // 3D地形用DEM（AWS Terrarium）＋陰影起伏
      map.addSource("dem", {
        type: "raster-dem",
        tiles: [`${AWS_DEM_HOST}/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`],
        tileSize: 256,
        encoding: "terrarium",
        maxzoom: 15,
        attribution: "Terrain: Mapzen/AWS Open Data",
      });
      map.addLayer({
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        layout: { visibility: "none" },
        paint: { "hillshade-exaggeration": 0.6 },
      });

      // PLATEAU建物3D（東京23区・LOD0、高さmで垂直避難先候補を色分け）。初期は非表示
      map.addSource("plateau", {
        type: "vector",
        tiles: [`${PLATEAU_MVT_HOST}/plateau-tokyo23ku-building-mvt-2020/{z}/{x}/{y}.pbf`],
        minzoom: 10,
        maxzoom: 16,
        attribution:
          '建物: <a href="https://github.com/indigo-lab/plateau-tokyo23ku-building-mvt-2020" target="_blank" rel="noopener noreferrer">PLATEAU TOKYO23ku MVT</a> / Project PLATEAU(国土交通省) CC BY 4.0',
      });
      map.addLayer({
        id: "plateau-bldg",
        type: "fill-extrusion",
        source: "plateau",
        "source-layer": "bldg",
        minzoom: 13,
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-height": ["coalesce", ["get", "measuredHeight"], 0],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.78,
          // 高いほど濃い緑＝垂直避難に適す。低層は灰
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "measuredHeight"], 0],
            0,
            "#cbd5e1",
            10,
            "#86efac",
            20,
            "#22c55e",
            40,
            "#15803d",
          ],
        },
      });

      // 地震の地域危険度(町丁目・#106)。面なので背景側に敷き、避難所の点を隠さない。
      // 塗りの指標(総合/建物倒壊/火災)はレイヤー1枚を feature-state ではなく
      // paint の切替で差し替える(データを持ち替えず描画式だけ変える)
      map.addSource("quake-risk", {
        type: "geojson",
        data: emptyFC(),
        attribution:
          "地震に関する地域危険度測定調査（第9回）東京都都市整備局 CC BY 4.0",
      });
      map.addLayer({
        id: "quake-risk-fill",
        type: "fill",
        source: "quake-risk",
        layout: { visibility: "none" },
        paint: {
          "fill-color": rankColorExpr("totalRank"),
          "fill-opacity": rankOpacityExpr("totalRank"),
        },
      });
      map.addLayer({
        id: "quake-risk-line",
        type: "line",
        source: "quake-risk",
        layout: { visibility: "none" },
        minzoom: 12, // 引きの画面で境界線を出すと真っ黒になるため、寄ったときだけ
        paint: { "line-color": "#9ca3af", "line-width": 0.5, "line-opacity": 0.6 },
      });

      // 想定震度・液状化の250mメッシュ(#106)
      map.addSource("quake-grid", {
        type: "geojson",
        data: emptyFC(),
        attribution:
          "首都直下地震等による東京の被害想定（令和4年度）東京都総務局 CC BY 4.0",
      });
      // 震度と液状化はメッシュのカバー範囲が違う（液状化は沖積低地のみ）。
      // 1ソースに両方の値を載せ、filter で欠損セルを落として指標を切り替える
      map.addLayer({
        id: "quake-grid-fill",
        type: "fill",
        source: "quake-grid",
        layout: { visibility: "none" },
        filter: ["has", "s"],
        paint: { "fill-color": SHINDO_COLOR, "fill-opacity": 0.45 },
      });

      map.addSource("all", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "all-pts",
        type: "circle",
        source: "all",
        paint: {
          "circle-radius": 3,
          "circle-color": "#6b7280",
          "circle-opacity": 0.45,
        },
      });

      // 生活継続レイヤー（給水拠点・公衆Wi-Fi）。初期は非表示。
      // all-ptsより上・rankedより下に積む（重要なランク済み避難所を最前面に保つ）。出典はsourceに付与
      map.addSource("lifeline", {
        type: "geojson",
        data: emptyFC(),
        attribution: "東京都オープンデータ(CC BY 4.0)",
      });
      map.addLayer({
        id: "lifeline-water",
        type: "circle",
        source: "lifeline",
        filter: ["==", ["get", "kind"], "water"],
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 5,
          "circle-color": "#0ea5e9",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "lifeline-wifi",
        type: "circle",
        source: "lifeline",
        filter: ["==", ["get", "kind"], "wifi"],
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 4,
          "circle-color": "#10b981",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });

      // 都営バス停レイヤー（拡大時のみ）。初期は非表示
      map.addSource("busstops", {
        type: "geojson",
        data: emptyFC(),
        attribution: "都営バス GTFS-JP(東京都交通局)／公共交通オープンデータセンター CC BY 4.0",
      });
      map.addLayer({
        id: "busstop-pts",
        type: "circle",
        source: "busstops",
        minzoom: 12,
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 5],
          "circle-color": "#a855f7",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });
      const busPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
      map.on("click", "busstop-pts", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { name?: string; wheelchair?: boolean | string };
        const wc = p.wheelchair === true || p.wheelchair === "true";
        busPopup
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            `<div style="font-size:12px;line-height:1.4"><b>🚌 ${escapeHtml(p.name ?? "")}</b>` +
              (wc ? "<br>車椅子対応" : "") +
              "</div>"
          )
          .addTo(map);
      });
      map.on("mouseenter", "busstop-pts", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "busstop-pts", () => {
        map.getCanvas().style.cursor = "";
      });

      // バリアフリー施設レイヤー（だれでも東京。避難経路上で立ち寄れる施設）。初期は非表示
      map.addSource("accessible", {
        type: "geojson",
        data: emptyFC(),
        attribution: "「だれでも東京」(東京都デジタルサービス局) CC BY 4.0",
      });
      map.addLayer({
        id: "accessible-pts",
        type: "circle",
        source: "accessible",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 6],
          "circle-color": "#f59e0b",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });
      const accPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
      map.on("click", "accessible-pts", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, unknown>;
        // バリアフリー属性(bool)を日本語ラベル化。MapLibreはpropertiesをstring化することがあるので両対応
        const on = (v: unknown) => v === true || v === "true";
        const flags: [string, string][] = [
          ["accessible_toilet", "だれでもトイレ"],
          ["ostomate", "オストメイト対応"],
          ["elevator", "エレベーター"],
          ["slope", "スロープ"],
          ["braille_block", "点字ブロック"],
          ["wheelchair_parking", "車いす駐車場"],
          ["diaper_change", "おむつ交換台"],
          ["assist_dog_toilet", "補助犬トイレ"],
        ];
        const have = flags.filter(([k]) => on(p[k])).map(([, label]) => label);
        const lines: string[] = [
          `<b>♿ ${escapeHtml(String(p.name ?? ""))}</b>`,
          `${escapeHtml(String(p.category ?? ""))}${p.address ? " / " + escapeHtml(String(p.address)) : ""}`,
        ];
        lines.push(
          have.length ? "設備: " + have.map(escapeHtml).join("・") : "バリアフリー設備情報なし"
        );
        accPopup
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(`<div style="font-size:12px;line-height:1.4">${lines.join("<br>")}</div>`)
          .addTo(map);
      });
      map.on("mouseenter", "accessible-pts", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "accessible-pts", () => {
        map.getCanvas().style.cursor = "";
      });

      // 帰宅困難者向け 都立一時滞在施設レイヤー。初期は非表示
      map.addSource("tempstay", {
        type: "geojson",
        data: emptyFC(),
        attribution: "都立の一時滞在施設(東京都総務局) CC BY 4.0 / ジオコーディング: 国土地理院 住所検索API",
      });
      map.addLayer({
        id: "tempstay-pts",
        type: "circle",
        source: "tempstay",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.5, 16, 7],
          "circle-color": "#4f46e5",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });
      const tsPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
      map.on("click", "tempstay-pts", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { name?: string; address?: string };
        const lines: string[] = [`<b>🏢 ${escapeHtml(p.name ?? "")}</b>`, "帰宅困難者の一時滞在施設（都立）"];
        if (p.address) lines.push(escapeHtml(p.address));
        tsPopup
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(`<div style="font-size:12px;line-height:1.4">${lines.join("<br>")}</div>`)
          .addTo(map);
      });
      map.on("mouseenter", "tempstay-pts", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "tempstay-pts", () => {
        map.getCanvas().style.cursor = "";
      });

      // 地域危険度のクリックで町丁目の3指標をまとめて表示（#106）
      const riskPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
      map.on("click", "quake-risk-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as {
          city?: string;
          chome?: string;
          totalRank?: number;
          buildingRank?: number;
          fireRank?: number;
        };
        const rank = (v?: number) =>
          v == null ? "—" : `ランク${v}（${RANK_LABEL[v] ?? "—"}）`;
        riskPopup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font-size:12px;line-height:1.5">` +
              `<b>${escapeHtml(String(p.city ?? ""))}${escapeHtml(String(p.chome ?? ""))}</b><br>` +
              `総合危険度: ${rank(p.totalRank)}<br>` +
              `建物倒壊: ${rank(p.buildingRank)}<br>` +
              `火災（延焼）: ${rank(p.fireRank)}` +
              `</div>`
          )
          .addTo(map);
      });
      map.on("mouseenter", "quake-risk-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "quake-risk-fill", () => {
        map.getCanvas().style.cursor = "";
      });

      // 生活継続レイヤーのクリックで詳細ポップアップ＋カーソル変化
      const lifelinePopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
      for (const lk of ["lifeline-water", "lifeline-wifi"] as const) {
        map.on("click", lk, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as {
            kind?: string;
            name?: string;
            category?: string;
            capacity?: number | null;
            address?: string;
          };
          const lines: string[] = [];
          if (p.kind === "water") {
            lines.push(`<b>💧 ${escapeHtml(p.name ?? "")}</b>`);
            if (p.category) lines.push(escapeHtml(p.category));
            if (p.capacity != null) lines.push(`確保水量: ${escapeHtml(String(p.capacity))} ㎥`);
          } else {
            // 公衆Wi-Fi: データの正体(FREE Wi-Fi & TOKYO)を明示し、設置場所名(公衆電話ボックス併設等)は補助表示
            // ラベルも生テキストをescapeHtmlに通す（手書きの&amp;による二重エスケープ等を防ぐ）
            lines.push(`<b>📶 ${escapeHtml("公衆Wi-Fi（FREE Wi-Fi & TOKYO）")}</b>`);
            if (p.name) lines.push(`設置場所: ${escapeHtml(p.name)}`);
          }
          if (p.address) lines.push(escapeHtml(p.address));
          lifelinePopup
            .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(`<div style="font-size:12px;line-height:1.4">${lines.join("<br>")}</div>`)
            .addTo(map);
        });
        map.on("mouseenter", lk, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", lk, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      // 推奨避難所への徒歩経路(#38, #110)。全ポイントレイヤーより下(all-ptsの直下)に敷き、点を隠さない。
      // 経路は常に1本だけ表示するので、色は「どの線か」ではなく「その経路がどれだけ危険か」を表す。
      // a11y: 色だけに頼らず「危険=赤・破線 / 注意=橙・破線 / 通常=青・実線」でパターンも併用。
      // (line-dasharrayはデータ駆動不可のため、警戒度ごとにレイヤーを分ける)
      map.addSource("route", { type: "geojson", data: emptyFC() });
      // 白い縁取り。OSMの道路は黄〜橙系が多く、線を重ねただけでは背景に埋もれて追えない(#110)
      map.addLayer(
        {
          id: "route-line-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": ROUTE_CASING_WIDTH,
            "line-color": "#ffffff",
            "line-opacity": 0.95,
          },
        },
        "all-pts"
      );
      // 実線(青): 通常。深い浸水想定を通らない場合と、判定できない場合をまとめる。
      // 以前は「回避=緑」と分けていたが、緑は安全のお墨付きに見える一方、
      // 実際は想定区域図に照らして通っていないだけで当日の冠水・通行止めは保証しない。
      // 利用者の行動も変わらないため、判定不能と同じ扱いにした(#110)
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          filter: ["==", ["get", "risk"], "normal"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": ROUTE_WIDTH,
            "line-opacity": 0.95,
            "line-color": "#1d4ed8",
          },
        },
        "all-pts"
      );
      // 破線(橙): 注意。くるぶし〜膝下の浸水想定。流れがあれば危険だが歩ける場合もある
      map.addLayer(
        {
          id: "route-line-caution",
          type: "line",
          source: "route",
          filter: ["==", ["get", "risk"], "caution"],
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: {
            "line-width": ROUTE_WIDTH,
            "line-opacity": 1,
            "line-color": "#ea580c",
            "line-dasharray": DASH_STATIC,
          },
        },
        "all-pts"
      );
      // 破線(赤): 危険。膝上以上の浸水想定で歩行が困難になる。ここだけ破線を流して注意を引く
      map.addLayer(
        {
          id: "route-line-danger",
          type: "line",
          source: "route",
          filter: ["==", ["get", "risk"], "danger"],
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: {
            "line-width": ROUTE_WIDTH,
            "line-opacity": 1,
            "line-color": "#dc2626",
            "line-dasharray": DASH_STATIC,
          },
        },
        "all-pts"
      );

      map.addSource("ranked", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "ranked-pts",
        type: "circle",
        source: "ranked",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "rank"], 0, 12, 19, 6],
          "circle-color": ["case", ["==", ["get", "rank"], 0], "#dc2626", "#2563eb"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "ranked-label",
        type: "symbol",
        source: "ranked",
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: { "text-halo-width": 1.5, "text-halo-color": "#fff" },
      });
      // 反映は loaded 依存の各 effect に任せる（load時のクロージャで古い値を焼かない）
      setLoaded(true);
    });
    mapRef.current = map;

    // コンテナ幅/高さの変化(サイドバーのリサイズ・ウィンドウ変化)に地図を追従
    // ResizeObserver非対応環境でも地図がマウントできるようフィーチャ検出
    let ro: ResizeObserver | null = null;
    let resizeRaf = 0;
    if (typeof ResizeObserver !== "undefined") {
      // 高頻度の発火(ドラッグ中など)を1フレーム1回のmap.resize()に間引く
      ro = new ResizeObserver(() => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          map.resize();
        });
      });
      ro.observe(containerRef.current);
    }

    return () => {
      // アンマウント時は破棄のみ（setLoaded等のstate更新は不要）
      ro?.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 全避難所の反映（all か loaded が変わるたび最新値で setData）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("all") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: all,
    });
  }, [all, loaded]);

  // 絞り込み結果の反映
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const feats = ranked.map((r, i) => ({
      type: "Feature" as const,
      geometry: r.feature.geometry,
      properties: {
        rank: i,
        label: i === 0 ? `★ ${r.feature.properties.name}` : r.feature.properties.name,
      },
    }));
    (map.getSource("ranked") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: feats,
    });
    if (ranked.length > 0) {
      const b = new maplibregl.LngLatBounds();
      ranked.slice(0, 8).forEach((r) => b.extend(r.feature.geometry.coordinates));
      if (origin) b.extend(origin);
      map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
    }
  }, [ranked, origin, loaded]);

  // ハザードレイヤの表示切替
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const key of HAZARD_KEYS) {
      if (!map.getLayer(`hz-${key}`)) continue;
      map.setLayoutProperty(`hz-${key}`, "visibility", hazards.includes(key) ? "visible" : "none");
    }
  }, [hazards, loaded]);

  // 生活継続レイヤーの反映
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("lifeline") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: lifeline,
    });
  }, [lifeline, loaded]);

  // 生活継続レイヤーの表示切替
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const k of ["water", "wifi"] as const) {
      if (!map.getLayer(`lifeline-${k}`)) continue;
      map.setLayoutProperty(
        `lifeline-${k}`,
        "visibility",
        lifelineShow.includes(k) ? "visible" : "none"
      );
    }
  }, [lifelineShow, loaded]);

  // バス停レイヤーの反映
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("busstops") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: busStops,
    });
  }, [busStops, loaded]);

  // バス停レイヤーの表示切替
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (map.getLayer("busstop-pts")) {
      map.setLayoutProperty("busstop-pts", "visibility", showBusStops ? "visible" : "none");
    }
  }, [showBusStops, loaded]);

  // バリアフリー施設レイヤーの反映
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("accessible") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: accessibleFacilities,
    });
  }, [accessibleFacilities, loaded]);

  // バリアフリー施設レイヤーの表示切替
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (map.getLayer("accessible-pts")) {
      map.setLayoutProperty("accessible-pts", "visibility", showAccessible ? "visible" : "none");
    }
  }, [showAccessible, loaded]);

  // 一時滞在施設レイヤーの反映
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("tempstay") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: tempStay,
    });
  }, [tempStay, loaded]);

  // 一時滞在施設レイヤーの表示切替
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (map.getLayer("tempstay-pts")) {
      map.setLayoutProperty("tempstay-pts", "visibility", showTempStay ? "visible" : "none");
    }
  }, [showTempStay, loaded]);

  // 推奨避難所への徒歩経路(#38)の反映
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!routeLine || routeLine.coordinates.length < 2) {
      src.setData(emptyFC());
      return;
    }
    src.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: routeLine.coordinates },
          properties: { risk: routeLine.risk },
        },
      ],
    });
  }, [routeLine, loaded]);

  // 地域危険度(町丁目)の反映。3指標すべてを properties に載せ、切替は paint 式で行う
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("quake-risk") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: quakeRisk,
    });
  }, [quakeRisk, loaded]);

  // 地域危険度の表示指標の切替（null なら非表示）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const visible = quakeRiskLayer ? "visible" : "none";
    for (const id of ["quake-risk-fill", "quake-risk-line"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible);
    }
    if (quakeRiskLayer && map.getLayer("quake-risk-fill")) {
      map.setPaintProperty("quake-risk-fill", "fill-color", rankColorExpr(quakeRiskLayer));
      map.setPaintProperty("quake-risk-fill", "fill-opacity", rankOpacityExpr(quakeRiskLayer));
    }
  }, [quakeRiskLayer, loaded]);

  // 250mメッシュ(想定震度・液状化)の反映。セルは矩形ポリゴンとして起こす
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const src = map.getSource("quake-grid") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!quakeGrid) {
      src.setData(emptyFC());
      return;
    }
    const { cellLat, cellLon, cells } = quakeGrid;
    const features: GeoJSON.Feature[] = [];
    for (const [key, v] of Object.entries(cells)) {
      const [iLatStr, iLonStr] = key.split(",");
      const iLat = Number(iLatStr);
      const iLon = Number(iLonStr);
      if (!Number.isFinite(iLat) || !Number.isFinite(iLon)) continue;
      const y0 = iLat * cellLat;
      const x0 = iLon * cellLon;
      const y1 = y0 + cellLat;
      const x1 = x0 + cellLon;
      const props: Record<string, number> = {};
      if (v[0] != null) props.s = v[0];
      if (v[1] != null) props.p = v[1];
      if (Object.keys(props).length === 0) continue;
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
          ],
        },
        properties: props,
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }, [quakeGrid, loaded]);

  // 250mメッシュの表示指標の切替（震度 / 液状化）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !map.getLayer("quake-grid-fill")) return;
    map.setLayoutProperty("quake-grid-fill", "visibility", quakeGridLayer ? "visible" : "none");
    if (!quakeGridLayer) return;
    const shindo = quakeGridLayer === "shindo";
    // 値を持たないセルを filter で落とす（液状化は沖積低地しかデータが無い）
    map.setFilter("quake-grid-fill", ["has", shindo ? "s" : "p"]);
    map.setPaintProperty("quake-grid-fill", "fill-color", shindo ? SHINDO_COLOR : LIQ_COLOR);
  }, [quakeGridLayer, loaded]);

  // 3D地形(坂・起伏)の切替
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (threeD) {
      map.setTerrain({ source: "dem", exaggeration: 1.4 });
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "visible");
      map.easeTo({ pitch: 62, duration: 800 });
    } else {
      map.setTerrain(null);
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "none");
      map.easeTo({ pitch: 0, duration: 600 });
    }
  }, [threeD, loaded]);

  // PLATEAU建物3D（垂直避難）の表示切替。表示時はpitchを傾けて立体表示
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (map.getLayer("plateau-bldg")) {
      map.setLayoutProperty("plateau-bldg", "visibility", buildings3d ? "visible" : "none");
    }
    // pitchは3D地形(threeD)がOFFのときだけ建物3Dの状態で決める。
    // threeD ON時はそちら(3D地形effect)がpitchを管理し、競合・残留を避ける
    if (!threeD) {
      map.easeTo({ pitch: buildings3d ? 55 : 0, duration: 700 });
    }
  }, [buildings3d, threeD, loaded]);

  // 危険な経路の破線を流して注意を引く(#110)。
  // 危険な経路が表示されているときだけ動かし、それ以外では requestAnimationFrame を回さない。
  const routeDanger = routeLine?.risk === "danger";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !map.getLayer("route-line-danger")) return;
    if (!routeDanger || reduceMotion) {
      map.setPaintProperty("route-line-danger", "line-dasharray", DASH_STATIC);
      return;
    }
    let raf = 0;
    let step = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last >= DASH_FRAME_MS) {
        step = (step + 1) % DASH_SEQUENCE.length;
        // スタイル差し替え等でレイヤーが消えている場合に備えて都度確認する
        if (map.getLayer("route-line-danger")) {
          map.setPaintProperty("route-line-danger", "line-dasharray", DASH_SEQUENCE[step]);
        }
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [routeDanger, reduceMotion, loaded]);

  // 結果リストで選ばれた避難所へ寄せる(#107)。
  // スマホでは一覧と地図を同時に見られないため、カードから位置を確かめる導線を用意する
  const focusSeq = focus?.seq;
  const focusLng = focus?.coordinates[0];
  const focusLat = focus?.coordinates[1];
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || focusLng == null || focusLat == null) return;
    // essential は付けない。付けると視差の軽減(prefers-reduced-motion)を無視して飛んでしまう。
    // 省略しておけば、その設定の端末では滑らかな移動ではなく即座に移動する
    map.flyTo({
      center: [focusLng, focusLat],
      zoom: Math.max(map.getZoom(), 16),
      duration: 700,
    });
    // seq を依存に含め、同じ避難所を選び直したときも寄せ直す
  }, [focusSeq, focusLng, focusLat, loaded]);

  // 現在地マーカー（origin が null ならマーカーを除去）
  const originMarker = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    originMarker.current?.remove();
    originMarker.current = null;
    if (!origin) return;
    originMarker.current = new maplibregl.Marker({ color: "#16a34a" })
      .setLngLat(origin)
      .setPopup(new maplibregl.Popup().setText("現在地"))
      .addTo(map);
  }, [origin, loaded]);

  return <div ref={containerRef} className="h-full w-full" />;
}

export { HAZARD_TILES };
