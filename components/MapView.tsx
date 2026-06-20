"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { EvacFeature, RankedEvac, HazardKey } from "@/lib/types";

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
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export default function MapView({ all, ranked, origin, hazards = [], threeD = false }: Props) {
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

    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
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
