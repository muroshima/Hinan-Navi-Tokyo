"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { EvacFeature, RankedEvac } from "@/lib/types";

const TOKYO: [number, number] = [139.7528, 35.6852];

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
  onPick?: (id: string) => void;
}

export default function MapView({ all, ranked, origin }: Props) {
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
      map.addSource("all", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "all-pts",
        type: "circle",
        source: "all",
        paint: {
          "circle-radius": 3,
          "circle-color": "#9ca3af",
          "circle-opacity": 0.5,
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
    // 1位 or 現在地にフィット
    if (ranked.length > 0) {
      const b = new maplibregl.LngLatBounds();
      ranked.slice(0, 8).forEach((r) => b.extend(r.feature.geometry.coordinates));
      if (origin) b.extend(origin);
      map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
    }
  };
  useEffect(updateRanked, [ranked, origin]);

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
