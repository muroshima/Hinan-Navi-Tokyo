"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  EvacCollection,
  EvacFeature,
  RankedEvac,
  UserAttrs,
  HazardKey,
  TimelinePhase,
  Lang,
  LifelineFeature,
  LifelineKind,
  BusStopFeature,
} from "@/lib/types";
import { DEFAULT_ATTRS, LANGS, LANG_CODES } from "@/lib/types";
import { QRCodeSVG } from "qrcode.react";
import { fallbackExtract, type FallbackAttrs } from "@/lib/triageFallback";
import {
  createRecognition,
  canRecognize,
  canSpeak,
  speak,
  stopSpeaking,
  type SpeechRecognitionLike,
} from "@/lib/speech";
import {
  rankEvacuations,
  explainDecision,
  enrichToiletNeeds,
  activeAttrLabels,
  HAZARD_LABEL,
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

// 地域・災害を限定しない例文を主に（最後に代表ケースの江戸川区水害）
const SAMPLES = [
  "雨の日、車椅子の母と避難したい。介助は私がします",
  "ベビーカーと0歳の子ども連れです。近くて入りやすい場所は？",
  "高齢の祖父と一緒。地震のとき逃げられる所を教えて",
  "夜に、目の不自由な父と逃げたい",
  "江戸川区で水害が心配。車椅子の母と避難したい",
];

// 共有URLの座標を検証して [lng, lat] で返す（両方が数値かつ範囲内のときのみ）
function parseSharedCoords(search: string): [number, number] | null {
  const sp = new URLSearchParams(search);
  const latRaw = sp.get("lat");
  const lngRaw = sp.get("lng");
  const lat = latRaw ? Number(latRaw) : NaN;
  const lng = lngRaw ? Number(lngRaw) : NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return [lng, lat];
  }
  return null;
}

// 現在地→避難所 の徒歩ルートをGoogleマップで開くURL
function gmapsWalkingUrl(origin: [number, number], dest: [number, number]): string {
  const o = `${origin[1]},${origin[0]}`; // lat,lng
  const d = `${dest[1]},${dest[0]}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=walking`;
}

// スコアの加減点内訳をバーで可視化（説明可能性）。正=緑/負=赤
function ScoreBreakdown({ r }: { r: RankedEvac }) {
  // 表示用に各deltaを整数へ丸め、合計も「丸め後の各行の和」にする。
  // これで「各行を足すと合計に一致」が保証され、内訳としての整合性が崩れない
  const shown = r.factors.map((f) => ({ f, d: Math.round(f.delta) }));
  const maxAbs = Math.max(1, ...shown.map((s) => Math.abs(s.d)));
  const total = shown.reduce((s, x) => s + x.d, 0);
  return (
    <div className="mt-1 rounded-md bg-gray-50 p-2">
      <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-gray-600">
        <span>点数内訳</span>
        <span className="tabular-nums">合計 {total}点</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {shown.map(({ f, d }) => (
          <div key={`${f.category}-${f.label}`} className="flex items-center gap-1 text-[11px]">
            <span className="w-32 shrink-0 truncate text-gray-600" title={f.label}>
              {f.label}
            </span>
            <div className="relative h-2.5 flex-1 rounded bg-gray-100">
              <div
                className={`absolute top-0 h-2.5 rounded ${d >= 0 ? "bg-green-400" : "bg-red-400"}`}
                style={{ width: `${(Math.abs(d) / maxAbs) * 100}%` }}
              />
            </div>
            <span
              className={`w-9 shrink-0 text-right tabular-nums ${
                d >= 0 ? "text-green-700" : "text-red-600"
              }`}
            >
              {d >= 0 ? "+" : ""}
              {d}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// スコア内訳の開閉カード。openはstateで完全制御し、
// ユーザー未操作の間はdefaultOpenの変化(新1位など)に追従して自動展開する。
// summaryのonClickでユーザー操作のみを捕捉する(onToggleだとプログラム変更も発火し誤検知するため)
function CardBreakdown({ r, defaultOpen }: { r: RankedEvac; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(defaultOpen);
  }, [defaultOpen]);
  return (
    <details open={open} className="mt-1.5">
      <summary
        onClick={(e) => {
          e.preventDefault(); // ネイティブtoggleを止めてstateで制御
          touched.current = true; // 以降はユーザー操作を優先（defaultOpen追従を停止）
          setOpen((o) => !o);
        }}
        className="cursor-pointer list-none text-[11px] font-bold text-gray-500 hover:text-gray-700"
      >
        {open ? "▾" : "▸"} なぜこの点数？（内訳を{open ? "表示中" : "見る"}）
      </summary>
      <ScoreBreakdown r={r} />
    </details>
  );
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
  const [submittedText, setSubmittedText] = useState(""); // 最後に検索に使った入力文（共有URL用）
  const [attrs, setAttrs] = useState<UserAttrs>(DEFAULT_ATTRS);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [hazards, setHazards] = useState<HazardKey[]>([]);
  const [threeD, setThreeD] = useState(false);
  // 生活継続レイヤー（給水拠点・公衆Wi-Fi）
  const [lifeline, setLifeline] = useState<LifelineFeature[]>([]);
  const [lifelineShow, setLifelineShow] = useState<LifelineKind[]>([]);
  const toggleLifeline = (k: LifelineKind) =>
    setLifelineShow((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const [buildings3d, setBuildings3d] = useState(false); // PLATEAU建物3D（垂直避難）
  const [busStops, setBusStops] = useState<BusStopFeature[]>([]); // 都営バス停
  const [showBusStops, setShowBusStops] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [originLabel, setOriginLabel] = useState("自動取得 / 東京駅");
  const [placeInput, setPlaceInput] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  // サイドバー可変幅(デスクトップのみ)
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [isDesktop, setIsDesktop] = useState(false);
  // マイ・タイムライン（属性×災害×推奨避難先 → LLM行動リスト）
  const [timeline, setTimeline] = useState<TimelinePhase[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineSource, setTimelineSource] = useState<string | null>(null);
  const timelineReqId = useRef(0); // 最新リクエスト以外のレスポンスを破棄するための識別子
  // 出力言語・音声入出力（アクセシビリティ／多言語）
  const [lang, setLang] = useState<Lang>("ja");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [voiceIn, setVoiceIn] = useState(false);
  const [voiceOut, setVoiceOut] = useState(false);
  // 家族・支援者への共有（URL/QR）
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // 音声機能の対応可否はマウント後に判定（SSRと不一致を避ける）。
    // setStateはマイクロタスクに逃がす（effect内の同期setStateを避ける。Promiseは広く対応）
    Promise.resolve().then(() => {
      setVoiceIn(canRecognize());
      setVoiceOut(canSpeak());
    });
    // アンマウント時は音声認識・読み上げを停止（マイク取得や読み上げの継続を防ぐ）
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        // ハンドラを外してからstop（stop後のonendでアンマウント後setStateが走らないように）
        rec.onresult = null;
        rec.onend = null;
        rec.onerror = null;
        rec.stop();
      }
      recognitionRef.current = null;
      stopSpeaking();
    };
  }, []);

  // 音声認識を確実に停止し、ref/stateを同期クリア（onend待ちに依存しない）
  function stopRecognition() {
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      rec.stop();
    }
    recognitionRef.current = null;
    setListening(false);
  }

  // 音声入力の開始/停止（Web Speech API・対応ブラウザのみ）
  function toggleVoiceInput() {
    if (listening) {
      stopRecognition();
      return;
    }
    const rec = createRecognition(lang);
    if (!rec) return;
    rec.onresult = (e) => {
      const t = e.results[0]?.[0]?.transcript ?? "";
      if (t) setText((prev) => (prev ? `${prev} ${t}` : t));
    };
    // 自然終了・エラー終了でも state と ref を一貫してクリア
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    rec.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      // start()が例外を投げ得る（権限・多重開始等）。失敗時はロールバック
      recognitionRef.current = null;
      setListening(false);
    }
  }

  // タイムラインを読み上げる（SpeechSynthesis）。区切りは言語に応じて切替
  function speakTimeline() {
    if (!timeline) return;
    const sep = lang === "en" ? ". " : "。";
    const text = timeline
      .map((p) => `${p.phase}${sep}${p.level}${sep}${p.actions.join(sep)}`)
      .join(sep);
    speak(text, lang);
  }

  const toggleHazard = (key: HazardKey) =>
    setHazards((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // 画面幅でデスクトップ判定（md=768px）
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    // 旧Safari(addEventListener非対応)は addListener にフォールバック
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);

  // ドラッグ中の後始末関数を保持し、アンマウント時にも確実に解除する
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);

  // サイドバー幅のドラッグ調整
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeCleanup.current?.(); // 既存ドラッグが残っていれば先に終了（二重登録防止）
    const prevUserSelect = document.body.style.userSelect; // 既存値を保存して復元
    // mousemoveごとのsetStateを1フレーム1回に間引く（再レンダリング多発を防ぐ）
    let raf = 0;
    let lastX = 0;
    const onMove = (ev: MouseEvent) => {
      lastX = ev.clientX;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        setSidebarWidth(Math.min(640, Math.max(300, lastX)));
      });
    };
    const end = () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", end); // ウィンドウがフォーカスを失っても解除
      document.body.style.userSelect = prevUserSelect;
      resizeCleanup.current = null;
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", end);
    resizeCleanup.current = end; // ドラッグ中アンマウント時もこの関数で後始末
  }, []);

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
    // 生活継続レイヤー（給水拠点・公衆Wi-Fi）
    fetch("/data/lifeline.geojson")
      .then((r) => r.json())
      .then((fc: { features?: LifelineFeature[] }) => setLifeline(fc.features ?? []))
      .catch((e) => {
        console.warn("lifeline load failed", e);
        setLifeline([]);
      });
    // 都営バス停（GTFS）
    fetch("/data/bus_stops.geojson")
      .then((r) => r.json())
      .then((fc: { features?: BusStopFeature[] }) => setBusStops(fc.features ?? []))
      .catch((e) => {
        console.warn("bus_stops load failed", e);
        setBusStops([]);
      });
  }, []);

  // 現在地（取れなければ東京駅）。共有URLに有効な座標がある場合はGPSで上書きしない
  useEffect(() => {
    if (typeof window !== "undefined" && parseSharedCoords(window.location.search)) return;
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
  function handleMyLocation() {
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
    let aborted = false;
    (async () => {
      const top = ranked.slice(0, 8);
      if (top.length === 0) {
        if (!aborted) setRouteInfo({});
        return;
      }
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
        if (!aborted) setRouteInfo(map);
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

  // マイ・タイムラインを生成（推奨1位・属性・想定災害をもとに）
  async function genTimeline() {
    const top = ranked[0];
    if (!top) return;
    const myId = ++timelineReqId.current; // このリクエストの識別子
    setTimelineLoading(true);
    setTimeline(null); // 再生成・失敗時に前回の結果が残らないよう先にクリア
    setTimelineSource(null);
    try {
      const res = await fetch("/api/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attrs,
          destName: top.feature.properties.name,
          distanceKm: top.distanceKm,
          hazardLabel: attrs.hazard ? HAZARD_LABEL[attrs.hazard] : undefined,
          language: lang,
        }),
      });
      // 新しい検索/再生成が走っていたら、古いレスポンスは破棄（不整合防止）
      if (myId !== timelineReqId.current) return;
      if (!res.ok) return;
      const data = await res.json();
      if (myId !== timelineReqId.current) return;
      if (Array.isArray(data.timeline)) {
        setTimeline(data.timeline);
        setTimelineSource(data.source ?? null);
      }
    } catch {
      /* 失敗時は何も表示しない */
    } finally {
      if (myId === timelineReqId.current) setTimelineLoading(false);
    }
  }

  // overrideText: 共有URL等から渡す入力 / skipGeocode: 座標が確定済みで地名再変換しない
  async function handleSubmit(opts?: { overrideText?: string; skipGeocode?: boolean }) {
    const q = (opts?.overrideText ?? text).trim();
    if (!q) return;
    const allowGeocodeBase = !opts?.skipGeocode;
    setLoading(true);
    setSubmitError(null);
    // 新しい検索のたびに前回のタイムライン・共有リンクを破棄し、進行中の生成も無効化
    timelineReqId.current++;
    setTimeline(null);
    setTimelineSource(null);
    setTimelineLoading(false);
    setShareUrl(null);
    // 抽出結果(LLM or 語句一致fallback)を画面に反映する共通処理
    const applyExtracted = (
      extracted: FallbackAttrs,
      source: string | null,
      allowGeocode: boolean
    ) => {
      // location(出発地)は属性とは別扱い（現在地に反映）
      const { location, ...a } = extracted;
      const hz = a.hazard;
      const hazard: HazardKey | null =
        typeof hz === "string" && hz !== "none" ? (hz as HazardKey) : null;
      setAttrs({ ...DEFAULT_ATTRS, ...a, hazard });
      setSource(source);
      setSubmitted(true);
      setSubmittedText(q); // 共有URLは画面に反映された入力文を使う（編集中textとのズレ防止）
      // 抽出された災害に対応するハザードレイヤを自動でON
      if (hazard && HAZARD_LAYERS.some((h) => h.key === hazard)) {
        setHazards((prev) => (prev.includes(hazard) ? prev : [...prev, hazard]));
      }
      // 文中に地名があれば現在地に反映（ジオコーディングは要ネットワーク。オフライン時はスキップ）
      if (allowGeocode && typeof location === "string" && location.trim()) {
        const place = location.trim();
        void (async () => {
          try {
            const gr = await fetch(`/api/geocode?q=${encodeURIComponent(place)}`);
            if (!gr.ok) return;
            const g = await gr.json();
            if (Number.isFinite(g.lng) && Number.isFinite(g.lat)) {
              setOrigin([g.lng, g.lat]);
              setOriginLabel(g.label?.split(",").slice(0, 2).join("・") || place);
            }
          } catch {
            /* 失敗時は現在地を変更しない */
          }
        })();
      }
    };

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: q }),
      });
      if (!res.ok) {
        setSubmitError("属性の抽出に失敗しました。少し待って再度お試しください。");
        return; // submitted は変えない（前の結果を保持）
      }
      const data = await res.json();
      applyExtracted(data.attrs ?? {}, data.source ?? null, allowGeocodeBase);
    } catch {
      // オフライン/通信失敗時はクライアント側の語句一致fallbackで検索を成立させる
      // （避難所データはSWでキャッシュ済みのため圏外でも一覧・ランキングが動く）
      applyExtracted(fallbackExtract(q), "offline", false);
    } finally {
      setLoading(false);
    }
  }

  // 家族・支援者に共有するURL（入力文＋現在地＋言語）を生成
  function buildShareUrl(): string {
    const params = new URLSearchParams();
    const shareText = submittedText.trim();
    if (shareText) params.set("q", shareText);
    params.set("lat", origin[1].toFixed(6));
    params.set("lng", origin[0].toFixed(6));
    params.set("lang", lang);
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  }

  function openShare() {
    setShareUrl(buildShareUrl());
    setCopied(false);
  }

  async function copyShare() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      /* クリップボード不可時はURL表示のみ */
    }
  }

  // 現在地が変わったら共有URLは陳腐化するため自動でクリア（GPS/地名設定/自動ジオコード等）
  useEffect(() => {
    // setStateはマイクロタスクに逃がす（effect内の同期setStateを避ける）
    Promise.resolve().then(() => {
      setShareUrl(null);
      setCopied(false);
    });
  }, [origin]);

  // 共有URLで開かれた場合は状態を復元して自動検索
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get("q");
    const coords = parseSharedCoords(window.location.search);
    const l = sp.get("lang");
    const validLang = !!l && (LANG_CODES as readonly string[]).includes(l);
    if (!q && !coords && !validLang) return;
    // setStateはマイクロタスクに逃がす（effect内の同期setStateを避ける）
    Promise.resolve().then(() => {
      if (validLang) setLang(l as Lang);
      if (coords) {
        setOrigin(coords);
        setOriginLabel("共有された地点");
      }
      if (q) {
        setText(q);
        void handleSubmit({ overrideText: q, skipGeocode: !!coords });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col md:flex-row">
      {/* 左: 操作パネル（モバイルは上部、デスクトップは可変幅の左カラム） */}
      <aside
        style={isDesktop ? { width: sidebarWidth } : undefined}
        className="flex h-[48vh] w-full shrink-0 flex-col gap-3 overflow-y-auto border-b border-gray-200 bg-white p-4 md:h-screen md:w-[400px] md:border-b-0 md:border-r"
      >
        <header>
          <h1 className="text-xl font-bold text-gray-900">だれでも避難ナビ TOKYO</h1>
          <p className="text-sm text-gray-600">
            ことばで状況を伝えると、あなたが行ける避難所を探します
          </p>
        </header>

        {/* 出力言語（やさしい日本語・多言語）＋ 音声入力 */}
        <div className="flex items-center gap-2">
          <label htmlFor="lang" className="text-xs font-bold text-gray-700">
            言語
          </label>
          <select
            id="lang"
            value={lang}
            onChange={(e) => {
              setLang(e.target.value as Lang);
              // 録音中なら停止（認識言語のズレ防止）
              stopRecognition();
              // 既存タイムライン・共有リンクは別言語のため破棄し、進行中の生成・読み上げも無効化
              timelineReqId.current++;
              setTimeline(null);
              setTimelineSource(null);
              setTimelineLoading(false);
              setShareUrl(null);
              stopSpeaking();
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          {voiceIn && (
            <button
              onClick={toggleVoiceInput}
              aria-pressed={listening}
              className={`ml-auto rounded-md border px-2 py-1 text-xs ${
                listening
                  ? "border-red-500 bg-red-50 text-red-700"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100"
              }`}
            >
              {listening ? "● 録音中…停止" : "🎤 音声入力"}
            </button>
          )}
        </div>

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
              onClick={handleMyLocation}
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
          onClick={() => handleSubmit()}
          disabled={loading || !text.trim()}
          className="rounded-lg bg-blue-600 px-4 py-3 text-base font-bold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {loading ? "考えています…" : "避難所をさがす"}
        </button>
        {submitError && <p className="text-xs text-red-600">{submitError}</p>}

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
            aria-pressed={threeD}
            className={`mt-2 w-full rounded-md border px-2 py-1 text-xs ${
              threeD
                ? "border-emerald-500 bg-emerald-100 text-emerald-800"
                : "border-gray-300 text-gray-600 hover:bg-gray-100"
            }`}
          >
            {threeD ? "⛰ 3D地形 ON（坂・起伏を表示）" : "⛰ 3D地形で坂・起伏を見る"}
          </button>
          <button
            onClick={() => setBuildings3d((v) => !v)}
            aria-pressed={buildings3d}
            className={`mt-1 w-full rounded-md border px-2 py-1 text-xs ${
              buildings3d
                ? "border-green-600 bg-green-100 text-green-800"
                : "border-gray-300 text-gray-600 hover:bg-gray-100"
            }`}
          >
            {buildings3d
              ? "🏢 建物3D ON（高い建物＝垂直避難先・拡大で表示）"
              : "🏢 建物3Dで垂直避難先を見る（水害時・23区）"}
          </button>
          <p className="mt-1 text-[10px] text-gray-400">
            建物: Project PLATEAU(国土交通省) CC BY 4.0。高いほど濃い緑＝上階避難に適す
          </p>
        </div>

        {/* 生活継続レイヤー（給水拠点・公衆Wi-Fi） */}
        <div className="rounded-lg border border-gray-200 p-2">
          <div className="mb-1 text-xs font-bold text-gray-700">生活継続レイヤー（避難後の備え）</div>
          <div className="flex flex-wrap gap-1">
            {([
              { key: "water", label: "💧 給水拠点", on: "border-sky-500 bg-sky-100 text-sky-800" },
              { key: "wifi", label: "📶 公衆Wi-Fi", on: "border-emerald-500 bg-emerald-100 text-emerald-800" },
            ] as const).map((it) => {
              const active = lifelineShow.includes(it.key);
              return (
                <button
                  key={it.key}
                  onClick={() => toggleLifeline(it.key)}
                  aria-pressed={active}
                  className={`rounded-full border px-2 py-1 text-xs ${
                    active ? it.on : "border-gray-300 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {active ? "● " : "○ "}
                  {it.label}
                </button>
              );
            })}
            <button
              onClick={() => setShowBusStops((v) => !v)}
              aria-pressed={showBusStops}
              className={`rounded-full border px-2 py-1 text-xs ${
                showBusStops
                  ? "border-purple-500 bg-purple-100 text-purple-800"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100"
              }`}
            >
              {showBusStops ? "● " : "○ "}
              🚌 バス停
            </button>
          </div>
          <p className="mt-1 text-[10px] text-gray-400">
            出典: 東京都オープンデータ（災害時給水ステーション／FREE Wi-Fi & TOKYO）・都営バスGTFS（東京都交通局／ODPT）— CC BY 4.0。バス停は拡大で表示
          </p>
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

        {/* マイ・タイムライン（属性×災害×推奨避難先 → 時系列の避難行動） */}
        {submitted && ranked.length > 0 && (
          <div className="rounded-lg border border-sky-300 bg-sky-50 p-3">
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-bold text-sky-800">📋 あなたのマイ・タイムライン</span>
              <div className="flex gap-1">
                {timeline && voiceOut && (
                  <button
                    onClick={speakTimeline}
                    title="タイムラインを読み上げる"
                    className="rounded-md border border-sky-400 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100"
                  >
                    🔊 読み上げ
                  </button>
                )}
                <button
                  onClick={genTimeline}
                  disabled={timelineLoading}
                  className="rounded-md bg-sky-600 px-2 py-1 text-xs text-white hover:bg-sky-700 disabled:opacity-40"
                >
                  {timelineLoading ? "作成中…" : timeline ? "作り直す" : "行動計画をつくる"}
                </button>
              </div>
            </div>
            {!timeline && !timelineLoading && (
              <p className="mt-1 text-[11px] text-sky-700">
                あなたの状況と推奨避難先「{ranked[0].feature.properties.name}」に合わせ、警戒レベルに沿った避難の手順を作成します
              </p>
            )}
            {timeline && (
              <div className="mt-2 flex flex-col gap-2">
                {timeline.map((ph, pi) => (
                  <div key={`${ph.phase}-${pi}`} className="relative pl-4">
                    <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-sky-500" />
                    <div className="text-xs font-bold text-sky-900">{ph.phase}</div>
                    <div className="text-[10px] text-sky-600">{ph.level}</div>
                    <ul className="mt-0.5 list-disc pl-4 text-xs text-gray-700">
                      {ph.actions.map((a, ai) => (
                        <li key={ai}>{a}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                {timelineSource && (
                  <span className="text-[10px] text-gray-400">
                    （生成: {timelineSource === "gemini" ? "AI" : "簡易ルール"}・参考情報です。最終判断は自治体の情報に従ってください）
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* 家族・支援者への共有（URL/QR） */}
        {submitted && ranked.length > 0 && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-bold text-emerald-800">🔗 家族・支援者に共有</span>
              <button
                onClick={openShare}
                className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
              >
                {shareUrl ? "更新" : "共有リンク/QRを作る"}
              </button>
            </div>
            {!shareUrl && (
              <p className="mt-1 text-[11px] text-emerald-700">
                今の状況・現在地・言語をリンク/QRにします。受け取った人が開くと同じ避難先が表示されます
              </p>
            )}
            {shareUrl && (
              <div className="mt-2 flex flex-col items-center gap-2">
                <div className="rounded-md bg-white p-2">
                  <QRCodeSVG value={shareUrl} size={140} title="避難先を共有するQRコード" />
                </div>
                <div className="flex w-full gap-1">
                  <input
                    readOnly
                    value={shareUrl}
                    aria-label="避難先を共有するURL（選択してコピーできます）"
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-700"
                  />
                  <button
                    onClick={copyShare}
                    className="shrink-0 rounded-md border border-emerald-400 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100"
                  >
                    {copied ? "✓ コピー" : "コピー"}
                  </button>
                </div>
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
                  {r.feature.properties.agingRate != null && (
                    <span className="ml-1 text-gray-400">
                      🧓 高齢化率{r.feature.properties.agingRate}%
                      {r.feature.properties.agingLevel === "chome" ? "(町丁目)" : ""}
                    </span>
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
              {/* 点数内訳（説明可能性）。1位は自動展開、他はトグル */}
              <CardBreakdown r={r} defaultOpen={i === 0} />
            </div>
          ))}
        </div>
      </aside>

      {/* リサイズハンドル（デスクトップのみ・キーボード操作対応） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="サイドバーの幅を調整（左右キーで変更）"
        aria-valuemin={300}
        aria-valuemax={640}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setSidebarWidth((w) => Math.max(300, w - 24));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setSidebarWidth((w) => Math.min(640, w + 24));
          }
        }}
        title="ドラッグ／左右キーで幅を調整"
        className="hidden w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 focus:bg-blue-500 focus:outline-none md:block"
      />

      {/* 右: 地図 */}
      <main className="relative min-h-0 flex-1">
        <MapView
          all={all}
          ranked={ranked}
          origin={origin}
          hazards={hazards}
          threeD={threeD}
          lifeline={lifeline}
          lifelineShow={lifelineShow}
          buildings3d={buildings3d}
          busStops={busStops}
          showBusStops={showBusStops}
        />
      </main>
    </div>
  );
}
