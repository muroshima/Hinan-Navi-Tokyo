"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { EvacCollection, EvacFeature, RankedEvac, UserAttrs, HazardKey } from "@/lib/types";
import { DEFAULT_ATTRS } from "@/lib/types";
import {
  rankEvacuations,
  explainDecision,
  enrichToiletNeeds,
  activeAttrLabels,
  type ToiletIndex,
} from "@/lib/ranking";

// MapLibreはSSR不可なのでクライアント専用で読み込む
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const TOKYO_STATION: [number, number] = [139.7671, 35.6812];

const ATTR_LABELS: { key: keyof UserAttrs; label: string }[] = [
  { key: "wheelchair", label: "車椅子" },
  { key: "elderly", label: "高齢・歩行不安" },
  { key: "stroller", label: "乳幼児連れ" },
  { key: "visual_impairment", label: "視覚障害" },
  { key: "hearing_impairment", label: "聴覚障害" },
  { key: "foreign_language", label: "外国語" },
  { key: "has_caregiver", label: "介助者あり" },
  { key: "ostomate", label: "オストメイト" },
  { key: "severe_care", label: "重度・要介護" },
  { key: "night", label: "🌙 夜間" },
  { key: "bad_weather", label: "☂ 雨・荒天" },
];

const EMPTY_TOILET_IDX: ToiletIndex = { baby: [], ostomate: [], largeBed: [], call: [] };

const SAMPLES = [
  "雨の日、車椅子の母と避難したい。介助は私がします",
  "ベビーカーと0歳の子ども連れです。近くて入りやすい場所は？",
  "高齢の祖父と一緒です。洪水のとき逃げられる所を教えて",
];

// 現在地→避難所 の徒歩ルートをGoogleマップで開くURL
function gmapsWalkingUrl(origin: [number, number], dest: [number, number]): string {
  const o = `${origin[1]},${origin[0]}`; // lat,lng
  const d = `${dest[1]},${dest[0]}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=walking`;
}

// MapViewのHAZARD_TILESと対応（重ね表示できるハザード）
const HAZARD_LAYERS: { key: HazardKey; label: string }[] = [
  { key: "flood", label: "洪水" },
  { key: "storm_surge", label: "高潮" },
  { key: "tsunami", label: "津波" },
  { key: "landslide", label: "土砂" },
];

export default function Home() {
  const [all, setAll] = useState<EvacFeature[]>([]);
  const [toiletIdx, setToiletIdx] = useState<ToiletIndex>(EMPTY_TOILET_IDX);
  const [routeInfo, setRouteInfo] = useState<Record<string, { m: number; min: number }>>({});
  const [origin, setOrigin] = useState<[number, number]>(TOKYO_STATION);
  const [text, setText] = useState("");
  const [attrs, setAttrs] = useState<UserAttrs>(DEFAULT_ATTRS);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [hazards, setHazards] = useState<HazardKey[]>([]);
  const [threeD, setThreeD] = useState(false);
  const [originLabel, setOriginLabel] = useState("自動取得 / 東京駅");
  const [placeInput, setPlaceInput] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const toggleHazard = (key: HazardKey) =>
    setHazards((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // データ読み込み
  useEffect(() => {
    fetch("/data/evacuation.geojson")
      .then((r) => r.json())
      .then((fc: EvacCollection) => setAll(fc.features))
      .catch(() => setAll([]));
    // 車椅子対応トイレBFデータ → 機能別に座標索引化
    fetch("/data/toilets.geojson")
      .then((r) => r.json())
      .then(
        (fc: {
          features: {
            geometry: { coordinates: [number, number] };
            properties: {
              a11y: {
                baby_change: boolean;
                ostomate: boolean;
                large_bed: boolean;
                call_button: boolean;
              };
            };
          }[];
        }) => {
          const idx: ToiletIndex = { baby: [], ostomate: [], largeBed: [], call: [] };
          for (const f of fc.features) {
            const a = f.properties?.a11y;
            if (!a) continue;
            const c = f.geometry.coordinates;
            if (a.baby_change) idx.baby.push(c);
            if (a.ostomate) idx.ostomate.push(c);
            if (a.large_bed) idx.largeBed.push(c);
            if (a.call_button) idx.call.push(c);
          }
          setToiletIdx(idx);
        }
      )
      .catch(() => setToiletIdx(EMPTY_TOILET_IDX));
  }, []);

  // 現在地（取れなければ東京駅）
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin([pos.coords.longitude, pos.coords.latitude]);
        setOriginLabel("現在地（GPS）");
      },
      () => {},
      { timeout: 5000 }
    );
  }, []);

  // GPSで現在地を取得
  function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoError("この端末では位置情報が使えません");
      return;
    }
    setGeoLoading(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin([pos.coords.longitude, pos.coords.latitude]);
        setOriginLabel("現在地（GPS）");
        setGeoLoading(false);
      },
      () => {
        setGeoError("位置情報を取得できませんでした");
        setGeoLoading(false);
      },
      { timeout: 8000 }
    );
  }

  // 住所・地名から現在地を設定
  async function geocodePlace() {
    const q = placeInput.trim();
    if (!q) return;
    setGeoLoading(true);
    setGeoError(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        setGeoError(res.status === 404 ? "場所が見つかりませんでした" : "変換に失敗しました");
        return;
      }
      const d = await res.json();
      setOrigin([d.lng, d.lat]);
      setOriginLabel(d.label?.split(",").slice(0, 2).join("・") || q);
    } catch {
      setGeoError("通信に失敗しました");
    } finally {
      setGeoLoading(false);
    }
  }

  const ranked: RankedEvac[] = useMemo(() => {
    if (!submitted || all.length === 0) return [];
    const base = rankEvacuations(all, origin, attrs, 20);
    return enrichToiletNeeds(base, toiletIdx, attrs);
  }, [submitted, all, origin, attrs, toiletIdx]);

  // 1位の根拠 ＋「より近いのに見送った候補」（意思決定支援）
  const decision = useMemo(() => {
    if (!submitted || ranked.length === 0) return null;
    return explainDecision(all, origin, attrs, ranked);
  }, [submitted, all, origin, attrs, ranked]);

  // 実経路の徒歩距離・所要（上位8件をOSRMでまとめて取得）
  useEffect(() => {
    const top = ranked.slice(0, 8);
    if (top.length === 0) {
      setRouteInfo({});
      return;
    }
    let aborted = false;
    (async () => {
      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin, dests: top.map((r) => r.feature.geometry.coordinates) }),
        });
        if (!res.ok) return;
        const { result } = await res.json();
        if (aborted || !Array.isArray(result)) return;
        const map: Record<string, { m: number; min: number }> = {};
        top.forEach((r, i) => {
          const d = result[i];
          // 距離は道路ネットワーク値を使い、所要は徒歩速度80m/分で概算（OSRM公開デモのdurationは車速のため不採用）
          if (d?.distM != null) {
            map[r.feature.properties.id] = { m: Math.round(d.distM), min: Math.max(1, Math.round(d.distM / 80)) };
          }
        });
        setRouteInfo(map);
      } catch {
        /* 失敗時は直線距離のみ表示 */
      }
    })();
    return () => {
      aborted = true;
    };
  }, [ranked, origin]);

  // 複合ニーズ（同時最適している配慮要件）のラベル
  const activeNeeds = useMemo(() => (submitted ? activeAttrLabels(attrs) : []), [submitted, attrs]);

  async function handleSubmit() {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      const a = data.attrs ?? {};
      const hazard: HazardKey | null = a.hazard && a.hazard !== "none" ? a.hazard : null;
      setAttrs({ ...DEFAULT_ATTRS, ...a, hazard });
      setSource(data.source ?? null);
      setSubmitted(true);
      // 抽出された災害に対応するハザードレイヤを自動でON
      if (hazard && HAZARD_LAYERS.some((h) => h.key === hazard)) {
        setHazards((prev) => (prev.includes(hazard) ? prev : [...prev, hazard]));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col md:flex-row">
      {/* 左: 操作パネル */}
      <aside className="flex w-full flex-col gap-3 overflow-y-auto border-b border-gray-200 bg-white p-4 md:w-[400px] md:border-b-0 md:border-r">
        <header>
          <h1 className="text-xl font-bold text-gray-900">だれでも避難ナビ TOKYO</h1>
          <p className="text-sm text-gray-600">
            ことばで状況を伝えると、あなたが行ける避難所を探します
          </p>
        </header>

        {/* 現在地（手動入力 or GPS） */}
        <div className="rounded-lg border border-gray-200 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-bold text-gray-700">現在地</span>
            <span className="max-w-[230px] truncate text-[11px] text-gray-500" title={originLabel}>
              📍 {originLabel}
            </span>
          </div>
          <div className="flex gap-1">
            <input
              value={placeInput}
              onChange={(e) => setPlaceInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && geocodePlace()}
              placeholder="住所・地名（例: 千代田区神田、新宿駅）"
              className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={geocodePlace}
              disabled={geoLoading || !placeInput.trim()}
              className="shrink-0 rounded-md bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-40"
            >
              設定
            </button>
            <button
              onClick={useMyLocation}
              disabled={geoLoading}
              title="GPSで現在地を取得"
              className="shrink-0 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40"
            >
              📍GPS
            </button>
          </div>
          {geoError && <p className="mt-1 text-[11px] text-red-600">{geoError}</p>}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例）雨の日、車椅子の母と避難したい"
          className="min-h-[80px] rounded-lg border border-gray-300 p-3 text-base text-gray-900 focus:border-blue-500 focus:outline-none"
        />
        <div className="flex flex-wrap gap-1">
          {SAMPLES.map((s) => (
            <button
              key={s}
              onClick={() => setText(s)}
              className="rounded-full border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
            >
              {s.slice(0, 14)}…
            </button>
          ))}
        </div>
        <button
          onClick={handleSubmit}
          disabled={loading || !text.trim()}
          className="rounded-lg bg-blue-600 px-4 py-3 text-base font-bold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {loading ? "考えています…" : "避難所をさがす"}
        </button>

        {submitted && (
          <div className="flex flex-wrap gap-1 text-xs">
            {ATTR_LABELS.filter((a) => attrs[a.key]).map((a) => (
              <span key={a.key} className="rounded bg-blue-100 px-2 py-1 text-blue-800">
                {a.label}
              </span>
            ))}
            {attrs.hazard && (
              <span className="rounded bg-orange-100 px-2 py-1 text-orange-800">
                災害: {attrs.hazard}
              </span>
            )}
            {source && <span className="text-gray-400">（抽出: {source}）</span>}
          </div>
        )}

        {/* 複合ニーズの同時最適を明示（既存サービスが扱えない強み） */}
        {submitted && activeNeeds.length >= 2 && (
          <div className="rounded-lg border border-violet-300 bg-violet-50 p-2 text-xs text-violet-900">
            🎯 <b>複合ニーズを同時に最適化</b>: {activeNeeds.join(" × ")}
            <span className="ml-1 text-violet-500">— {activeNeeds.length}条件を同時に考慮しています</span>
          </div>
        )}

        {/* ハザードレイヤ トグル */}
        <div className="rounded-lg border border-gray-200 p-2">
          <div className="mb-1 text-xs font-bold text-gray-700">ハザード重ね表示</div>
          <div className="flex flex-wrap gap-1">
            {HAZARD_LAYERS.map((h) => {
              const on = hazards.includes(h.key);
              return (
                <button
                  key={h.key}
                  onClick={() => toggleHazard(h.key)}
                  className={`rounded-full border px-2 py-1 text-xs ${
                    on
                      ? "border-orange-500 bg-orange-100 text-orange-800"
                      : "border-gray-300 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {on ? "● " : "○ "}
                  {h.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] text-gray-400">出典: ハザードマップポータルサイト(国土交通省)</p>
          <button
            onClick={() => setThreeD((v) => !v)}
            className={`mt-2 w-full rounded-md border px-2 py-1 text-xs ${
              threeD
                ? "border-emerald-500 bg-emerald-100 text-emerald-800"
                : "border-gray-300 text-gray-600 hover:bg-gray-100"
            }`}
          >
            {threeD ? "⛰ 3D地形 ON（坂・起伏を表示）" : "⛰ 3D地形で坂・起伏を見る"}
          </button>
        </div>

        {/* 1位の根拠 ＋ 行けない理由（意思決定支援） */}
        {decision && (
          <div className="flex flex-col gap-2">
            {ranked[0] && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3">
                <div className="text-xs font-bold text-red-700">
                  なぜ「{ranked[0].feature.properties.name}」が1位？
                </div>
                <p className="mt-1 text-sm text-gray-800">{decision.summary}</p>
              </div>
            )}
            {decision.nearerRejected && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                💡 より近い「{decision.nearerRejected.name}」（
                {decision.nearerRejected.distanceKm.toFixed(1)}km）もありますが、
                <b>{decision.nearerRejected.reason}</b>
                のため、上記を推奨します。
              </div>
            )}
          </div>
        )}

        {/* 結果リスト */}
        <div className="flex flex-col gap-2">
          {ranked.slice(0, 8).map((r, i) => (
            <div
              key={r.feature.properties.id}
              className={`rounded-lg border p-3 ${
                i === 0 ? "border-red-400 bg-red-50" : "border-gray-200"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <a
                  href={gmapsWalkingUrl(origin, r.feature.geometry.coordinates)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Googleマップで徒歩ルートを開く"
                  className="font-bold text-blue-700 underline decoration-dotted underline-offset-2 hover:text-blue-900"
                >
                  {i === 0 ? "★ " : `${i + 1}. `}
                  {r.feature.properties.name}
                </a>
                <span className="text-xs text-gray-500">
                  {routeInfo[r.feature.properties.id]
                    ? `徒歩約${routeInfo[r.feature.properties.id].min}分・${(
                        routeInfo[r.feature.properties.id].m / 1000
                      ).toFixed(1)}km`
                    : `直線${r.distanceKm.toFixed(1)}km`}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span>
                  {r.feature.properties.city}・
                  {r.feature.properties.kind === "center" ? "指定避難所" : "避難場所"}
                  {routeInfo[r.feature.properties.id] && (
                    <span className="ml-1 text-gray-400">(道路距離)</span>
                  )}
                </span>
                <a
                  href={gmapsWalkingUrl(origin, r.feature.geometry.coordinates)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-blue-300 px-1.5 py-0.5 text-blue-700 hover:bg-blue-50"
                >
                  🗺 ルート
                </a>
              </div>
              {r.reasons.slice(0, 3).map((reason) => (
                <div key={reason} className="text-xs text-green-700">
                  ✓ {reason}
                </div>
              ))}
              {r.cautions.slice(0, 2).map((c) => (
                <div key={c} className="text-xs text-amber-700">
                  ⚠ {c}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* 右: 地図 */}
      <main className="relative flex-1">
        <MapView all={all} ranked={ranked} origin={origin} hazards={hazards} threeD={threeD} />
      </main>
    </div>
  );
}
