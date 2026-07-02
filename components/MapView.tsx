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
} from "@/lib/types";

const TOKYO: [number, number] = [139.7528, 35.6852];

// 国交省ハザードマップポータルのラスタータイル（疎通確認済みの層のみ）
const HAZARD_TILES: Partial<Record<HazardKey, { url: string; label: string }>> = {
  flood: {
    url: "https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png",
    label: "洪水浸水想定",
  },
  storm_surge: {
    url: "https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png",
    label: "高潮浸水想定",
  },
  tsunami: {
    url: "https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png",
    label: "津波浸水想定",
  },
  landslide: {
    url: "https://disaportaldata.gsi.go.jp/raster/05_kyukeishakeikaikuiki/{z}/{x}/{y}.png",
    label: "土砂災害(急傾斜地)警戒区域",
  },
};

const HAZARD_KEYS = Object.keys(HAZARD_TILES) as HazardKey[];

// APIキー不要の OSM ラスタースタイル
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  // ラベル(symbol)描画にはglyphsが必須。APIキー不要のMapLibreデモフォントを使用
  // (日本語=CJKはMap側のlocalIdeographFontFamilyでローカル描画)
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
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
}

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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // load完了をstateで管理し、各反映effectの依存に含める
  // (loadより先にデータが届いても、loaded反転で確実に再反映される)
  const [loaded, setLoaded] = useState(false);

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
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
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
        tiles: ["https://indigo-lab.github.io/plateau-tokyo23ku-building-mvt-2020/{z}/{x}/{y}.pbf"],
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
