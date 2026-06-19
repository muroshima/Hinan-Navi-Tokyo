"use client";

import { useEffect, useRef } from "react";
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

export default function MapView({ all, ranked, origin, hazards = [], threeD = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);

  // 初期化
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: TOKYO,
      zoom: 11,
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

      // 3D地形用のDEM（AWS Terrarium、MapLibreネイティブ対応）＋陰影起伏
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
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: { "text-halo-width": 1.5, "text-halo-color": "#fff" },
      });
      loadedRef.current = true;
      updateAll();
      updateRanked();
      updateHazards();
      updateThreeD();
    });
    mapRef.current = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全避難所の反映
  const updateAll = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const src = map.getSource("all") as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: all });
  };
  useEffect(updateAll, [all]);

  // 絞り込み結果の反映
  const updateRanked = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const feats = ranked.map((r, i) => ({
      type: "Feature" as const,
      geometry: r.feature.geometry,
      properties: {
        rank: i,
        label: i === 0 ? `★ ${r.feature.properties.name}` : r.feature.properties.name,
      },
    }));
    const src = map.getSource("ranked") as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: feats });
    if (ranked.length > 0) {
      const b = new maplibregl.LngLatBounds();
      ranked.slice(0, 8).forEach((r) => b.extend(r.feature.geometry.coordinates));
      if (origin) b.extend(origin);
      map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
    }
  };
  useEffect(updateRanked, [ranked, origin]);

  // ハザードレイヤの表示切替
  const updateHazards = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    for (const key of HAZARD_KEYS) {
      if (!map.getLayer(`hz-${key}`)) continue;
      map.setLayoutProperty(
        `hz-${key}`,
        "visibility",
        hazards.includes(key) ? "visible" : "none"
      );
    }
  };
  useEffect(updateHazards, [hazards]);

  // 3D地形(坂・起伏)の切替
  const updateThreeD = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    if (threeD) {
      map.setTerrain({ source: "dem", exaggeration: 1.4 });
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "visible");
      map.easeTo({ pitch: 62, duration: 800 });
    } else {
      map.setTerrain(null);
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "none");
      map.easeTo({ pitch: 0, duration: 600 });
    }
  };
  useEffect(updateThreeD, [threeD]);

  // 現在地マーカー
  const originMarker = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !origin) return;
    originMarker.current?.remove();
    originMarker.current = new maplibregl.Marker({ color: "#16a34a" })
      .setLngLat(origin)
      .setPopup(new maplibregl.Popup().setText("現在地"))
      .addTo(map);
  }, [origin]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export { HAZARD_TILES };
