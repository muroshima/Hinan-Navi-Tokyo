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
  AccessibleFacilityFeature,
  TempStayFeature,
  QuakeGrid,
  QuakeGridLayer,
  QuakeRiskFeature,
  QuakeRiskLayer,
} from "@/lib/types";
import { DEFAULT_ATTRS, LANGS, LANG_CODES } from "@/lib/types";
import {
  buildQuakeRiskIndex,
  lookupQuakeRisk,
  analyzeQuakeRoute,
  RANK_LABEL,
} from "@/lib/quakeRisk";
import { QRCodeSVG } from "qrcode.react";
import BottomSheet, { PEEK_VH, type Snap } from "@/components/BottomSheet";
import { fallbackExtract, type FallbackAttrs } from "@/lib/triageFallback";
import { pickSafestRoute, type FloodGrid, type RouteInfo } from "@/lib/floodRoute";
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
  enrichQuakeRisk,
  describeOriginQuakeRisk,
  isQuakeContext,
  activeAttrLabels,
  distanceKm as straightDistanceKm,
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
  { key: "outside", label: "🚶 外出中" },
];

const EMPTY_TOILET_IDX: ToiletIndex = { baby: [], ostomate: [], largeBed: [], call: [] };

// 地域・災害を限定しない例文を主に（最後に代表ケースの江戸川区水害）
const SAMPLES = [
  "雨の日、車椅子の母と避難したい。介助は私がします",
  "ベビーカーと0歳の子ども連れです。近くて入りやすい場所は？",
  "高齢の祖父と一緒。地震のとき逃げられる所を教えて",
  "夜に、目の不自由な父と逃げたい",
  "大地震で火事が広がっている。足の悪い祖母と逃げたい",
  "職場にいるときに地震が起きたら。電車が止まって帰れない",
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
  // 浸水回避ルーティング(#38): 浸水グリッドと、推奨避難所へのOSRM経路(生)
  const [floodGrid, setFloodGrid] = useState<FloodGrid | null>(null);
  const [rawRoutes, setRawRoutes] = useState<RouteInfo[] | null>(null); // 推奨避難所へのOSRM経路(+代替)。取得はorigin/destのみに依存
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
  const [accessibleFacilities, setAccessibleFacilities] = useState<AccessibleFacilityFeature[]>([]); // バリアフリー施設(だれでも東京)
  const [showAccessible, setShowAccessible] = useState(false);
  const [tempStay, setTempStay] = useState<TempStayFeature[]>([]); // 帰宅困難者向け 都立一時滞在施設
  const [showTempStay, setShowTempStay] = useState(false);
  // 地震(#106): 地域危険度(町丁目)・想定震度/液状化(250mメッシュ)
  const [quakeRisk, setQuakeRisk] = useState<QuakeRiskFeature[]>([]);
  const [quakeGrid, setQuakeGrid] = useState<QuakeGrid | null>(null);
  const [quakeRiskLayer, setQuakeRiskLayer] = useState<QuakeRiskLayer | null>(null);
  const [quakeGridLayer, setQuakeGridLayer] = useState<QuakeGridLayer | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [originLabel, setOriginLabel] = useState("自動取得 / 東京駅");
  const [placeInput, setPlaceInput] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  // サイドバー可変幅(デスクトップのみ)
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [isDesktop, setIsDesktop] = useState(false);
  // モバイルのボトムシートの開き具合(#107)。検索前は入力に集中させたいので小さく始める
  const [snap, setSnap] = useState<Snap>("peek");
  // 結果カードから地図の該当地点へ寄せるための指定（同じ避難所を選び直せるよう連番を持つ）
  const [focus, setFocus] = useState<{ id: string; coordinates: [number, number]; seq: number } | null>(
    null
  );
  const focusSeq = useRef(0);
  // 値を増やすとシートの中身が先頭までスクロールする
  const [sheetScrollSignal, setSheetScrollSignal] = useState(0);
  // スマホで検索したあとは入力・設定欄を畳み、避難先を先に見せる（デスクトップは常に開いたまま）
  const [showControls, setShowControls] = useState(true);
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
    // バリアフリー施設（だれでも東京）
    fetch("/data/accessible_facilities.geojson")
      .then((r) => r.json())
      .then((fc: { features?: AccessibleFacilityFeature[] }) =>
        setAccessibleFacilities(fc.features ?? [])
      )
      .catch((e) => {
        console.warn("accessible_facilities load failed", e);
        setAccessibleFacilities([]);
      });
    // 帰宅困難者向け 都立一時滞在施設
    fetch("/data/temp_stay_facilities.geojson")
      .then((r) => r.json())
      .then((fc: { features?: TempStayFeature[] }) => setTempStay(fc.features ?? []))
      .catch((e) => {
        console.warn("temp_stay_facilities load failed", e);
        setTempStay([]);
      });
    // 地震の地域危険度(町丁目・#106)
    fetch("/data/quake_risk.geojson")
      .then((r) => r.json())
      .then((fc: { features?: QuakeRiskFeature[] }) => setQuakeRisk(fc.features ?? []))
      .catch((e) => {
        console.warn("quake_risk load failed", e);
        setQuakeRisk([]);
      });
    // 想定震度・液状化の250mメッシュ(#106)
    fetch("/data/quake_grid.json")
      .then((r) => r.json())
      .then((g: QuakeGrid) => setQuakeGrid(g && g.cells ? g : null))
      .catch((e) => {
        console.warn("quake_grid load failed", e);
        setQuakeGrid(null);
      });
    // 浸水回避ルーティング用の浸水グリッド(#38)
    fetch("/data/flood_grid.json")
      .then((r) => r.json())
      .then((g: FloodGrid) => setFloodGrid(g && g.cells ? g : null))
      .catch((e) => {
        console.warn("flood_grid load failed", e);
        setFloodGrid(null);
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

  // 町丁目ポリゴンは5,192件。検索のたびに総当たりしないよう bbox 索引を1度だけ組む
  const quakeIndex = useMemo(
    () => (quakeRisk.length ? buildQuakeRiskIndex(quakeRisk) : null),
    [quakeRisk]
  );

  // 現在地の地震リスク（想定災害が地震・火災のときだけ引く）
  const originQuakeRisk = useMemo(() => {
    if (!isQuakeContext(attrs)) return null;
    if (!quakeIndex && !quakeGrid) return null;
    return lookupQuakeRisk(origin, quakeIndex, quakeGrid);
  }, [attrs, origin, quakeIndex, quakeGrid]);

  const ranked: RankedEvac[] = useMemo(() => {
    if (!submitted || all.length === 0) return [];
    const base = rankEvacuations(all, origin, attrs, 20);
    const withToilets = enrichToiletNeeds(base, toiletIdx, attrs);
    return enrichQuakeRisk(withToilets, quakeIndex, quakeGrid, attrs, originQuakeRisk);
  }, [submitted, all, origin, attrs, toiletIdx, quakeIndex, quakeGrid, originQuakeRisk]);

  // 帰宅困難者モード（#106）: 地震 × 外出中。指定避難所は自宅を失った人の受け皿であり、
  // 帰宅できないだけの人がまず向かうべきなのは一時滞在施設。近い順に提示する
  const stranded = useMemo(() => {
    if (!submitted || !isQuakeContext(attrs) || !attrs.outside) return [];
    return tempStay
      .map((f) => ({
        feature: f,
        km: straightDistanceKm(origin, f.geometry.coordinates as [number, number]),
      }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 3);
  }, [submitted, attrs, tempStay, origin]);

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

  // 浸水回避ルーティング(#38): 推奨避難所への徒歩経路(+代替)をOSRMから取得。
  // 依存はプリミティブ(origin/dest座標)に絞り、属性トグルでrankedが再計算されても
  // 推奨避難所(dest)が変わらなければ再取得しない(OSRMデモのレート枠を無駄にしない)。
  const originLng = origin[0];
  const originLat = origin[1];
  const destLng = ranked[0]?.feature.geometry.coordinates[0];
  const destLat = ranked[0]?.feature.geometry.coordinates[1];
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      if (destLng == null || destLat == null) {
        setRawRoutes(null);
        return;
      }
      // 取得開始時に前回経路をクリアし、新しい推奨避難所×古い経路の不整合表示を防ぐ
      setRawRoutes(null);
      try {
        const res = await fetch("/api/walkroute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin: [originLng, originLat], dest: [destLng, destLat] }),
          signal: ctrl.signal, // cleanupで進行中リクエストを中断(OSRMへの無駄な到達を防ぐ)
        });
        if (!res.ok) {
          if (!ctrl.signal.aborted) setRawRoutes(null);
          return;
        }
        const { routes } = await res.json();
        if (!ctrl.signal.aborted) {
          setRawRoutes(Array.isArray(routes) && routes.length ? routes : null);
        }
      } catch {
        // abort由来の例外はstateを触らない(後続リクエストの結果を尊重)
        if (!ctrl.signal.aborted) setRawRoutes(null);
      }
    })();
    return () => ctrl.abort();
  }, [originLng, originLat, destLng, destLat]);

  // 浸水曝露の解析は純粋な導出。取得済み経路 × floodGrid から算出(grid変更時は再取得せず再解析のみ)。
  // 代替の中から浸水曝露が最小の経路を推奨し、最短経路との差・判定可否を提示する。
  const routeAdvisory = useMemo(() => {
    if (!rawRoutes) return null;
    const { ranked: analyzedRoutes, recommended } = pickSafestRoute(rawRoutes, floodGrid);
    const shortest = [...analyzedRoutes].sort(
      (a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity)
    )[0];
    if (!recommended || !shortest) return null;
    const avoidedFlood =
      shortest.flood.maxDepthM > 0 && recommended.flood.maxDepthM < shortest.flood.maxDepthM;
    // floodGridが無いと浸水判定は偽陰性になり得るため、判定有効フラグを持たせUIで区別する
    return { recommended, shortest, avoidedFlood, floodKnown: floodGrid != null };
  }, [rawRoutes, floodGrid]);

  // 地図へ渡す経路線。identityを安定させ、実データが変わった時だけMapViewが再描画するようにする
  // 地震を想定しているときは浸水の色分けを使わない（洪水想定の破線が地震の文脈では誤解を招く）。
  // 経路そのものは中立色の実線で出し、危険の説明は延焼・液状化チェックのパネルが担う
  const routeLine = useMemo(() => {
    if (!routeAdvisory) return null;
    if (isQuakeContext(attrs)) {
      return { coordinates: routeAdvisory.recommended.coordinates, flooded: false, floodKnown: false };
    }
    return {
      coordinates: routeAdvisory.recommended.coordinates,
      flooded: routeAdvisory.floodKnown && routeAdvisory.recommended.flood.maxDepthM > 0,
      floodKnown: routeAdvisory.floodKnown,
    };
  }, [routeAdvisory, attrs]);

  // 推奨避難所までの経路が、延焼・液状化の危険が高い地域を通らないか（#106）。
  // 地震では「避難先が安全か」より「そこへ行き着けるか」が問題になる
  const quakeRouteAdvisory = useMemo(() => {
    if (!isQuakeContext(attrs) || !routeAdvisory) return null;
    return analyzeQuakeRoute(routeAdvisory.recommended.coordinates, quakeIndex, quakeGrid);
  }, [attrs, routeAdvisory, quakeIndex, quakeGrid]);

  // 現在地の地震リスクを読める文にしたもの
  const originQuakeLines = useMemo(
    () => (submitted ? describeOriginQuakeRisk(originQuakeRisk) : []),
    [submitted, originQuakeRisk]
  );

  // 入力欄を畳むのはスマホで検索が終わったあとだけ。デスクトップのサイドバーは常に開いておく
  const controlsCollapsed = !isDesktop && submitted && !showControls;

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
          // 地震のときは現在地の地域危険度・想定被害を渡し、行動計画を土地の実情に寄せる
          quake: originQuakeRisk
            ? {
                fireRank: originQuakeRisk.fireRank,
                buildingRank: originQuakeRisk.buildingRank,
                totalRank: originQuakeRisk.totalRank,
                shindo: originQuakeRisk.shindo,
                liquefactionPL: originQuakeRisk.liquefactionPL,
              }
            : undefined,
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
      // 結果が出たらシートを引き上げ、入力欄は畳んで避難先を先頭に見せる
      setSnap((s) => (s === "peek" ? "half" : s));
      setShowControls(false);
      setSheetScrollSignal((n) => n + 1);
      setSubmittedText(q); // 共有URLは画面に反映された入力文を使う（編集中textとのズレ防止）
      // 抽出された災害に対応するハザードレイヤを自動でON
      if (hazard && HAZARD_LAYERS.some((h) => h.key === hazard)) {
        setHazards((prev) => (prev.includes(hazard) ? prev : [...prev, hazard]));
      }
      // 地震・大規模火事は重ねるタイルが無いかわりに、地域危険度を自動表示する(#106)。
      // 火災を想定しているなら延焼のしやすさ、地震一般なら総合危険度を出す
      if (hazard === "earthquake" || hazard === "fire") {
        setQuakeRiskLayer(hazard === "fire" ? "fireRank" : "totalRank");
        // 外出中なら帰宅困難者の待機先が要るため、一時滞在施設を地図に出す
        if (a.outside) setShowTempStay(true);
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
    // プライバシー(#67): 共有URLの座標は小数3桁(≈100m)に粗粒度化し、自宅などのピンポイント特定を避ける
    params.set("lat", origin[1].toFixed(3));
    params.set("lng", origin[0].toFixed(3));
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
    <div className="relative flex h-[100dvh] w-screen flex-col md:flex-row">
      {/* 操作パネル: モバイルはドラッグできるボトムシート、デスクトップは可変幅の左カラム(#107) */}
      <BottomSheet
        snap={snap}
        onSnapChange={setSnap}
        desktopWidth={isDesktop ? sidebarWidth : undefined}
        handleLabel={
          submitted && ranked.length > 0
            ? ranked.length > 1
              ? `${ranked[0].feature.properties.name} ほか ${Math.min(ranked.length, 8) - 1}件`
              : ranked[0].feature.properties.name
            : undefined
        }
        scrollTopSignal={sheetScrollSignal}
      >
        {/* 検索後のスマホでは見出しを畳む。画面が縦に短く、避難先までスクロールさせたくない */}
        <header className={controlsCollapsed ? "hidden" : undefined}>
          <h1 className="text-xl font-bold text-gray-900">だれでも避難ナビ TOKYO</h1>
          <p className="text-sm text-gray-600">
            ことばで状況を伝えると、あなたが行ける避難所を探します
          </p>
        </header>

        {/* 常時表示の免責(#25)。人命関与サービスとして最終判断は公式情報に委ねる旨を明示。
            畳んだ状態でも必ず出す（ここは省略してよい情報ではない）。スマホでは要点だけに縮める */}
        <div
          role="note"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <span className="md:hidden">
            ⚠️ <b>参考情報</b>です。避難の最終判断は<b>自治体の公式情報・指示</b>に従ってください。
          </span>
          <span className="hidden md:inline">
            ⚠️ 本サービスは<b>参考情報</b>です（ハッカソン用プロトタイプ）。掲載データは時点情報で実態と異なる場合があります。
            <b>避難の最終判断は必ず自治体の公式情報・指示に従ってください。</b>
          </span>
        </div>

        {/* 検索後のスマホで、条件の入力欄を畳んだときに開き直すための導線 */}
        {controlsCollapsed && (
          <button
            onClick={() => setShowControls(true)}
            className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-800 active:bg-blue-100"
          >
            🔍 条件を変えて探し直す
          </button>
        )}

        {/* 入力・設定のまとまり。検索後のスマホでは畳んで、結果を先に見せる */}
        <div className={controlsCollapsed ? "hidden" : "flex flex-col gap-3"}>
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
          <p className="mt-1 text-[10px] text-gray-600">
            ※ 現在地・住所は経路/地名検索のため外部サービス（OSRM・Nominatim）に送信されます
          </p>
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
        </div>
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
                災害: {HAZARD_LABEL[attrs.hazard]}
              </span>
            )}
            {source && <span className="text-gray-600">（抽出: {source}）</span>}
          </div>
        )}

        {/* 複合ニーズの同時最適を明示（既存サービスが扱えない強み） */}
        {submitted && activeNeeds.length >= 2 && (
          <div className="rounded-lg border border-violet-300 bg-violet-50 p-2 text-xs text-violet-900">
            🎯 <b>複合ニーズを同時に最適化</b>: {activeNeeds.join(" × ")}
            <span className="ml-1 text-violet-500">— {activeNeeds.length}条件を同時に考慮しています</span>
          </div>
        )}

        {/* 帰宅困難者モード（#106）: 地震 × 外出中。
            指定避難所は自宅を失った人の受け皿。帰宅できないだけなら一時滞在施設で待つのが原則 */}
        {stranded.length > 0 && (
          <div className="rounded-lg border border-indigo-300 bg-indigo-50 p-3">
            <div className="text-xs font-bold text-indigo-800">🏢 外出中に地震が起きたら</div>
            <p className="mt-1 text-sm text-indigo-900">
              <b>むやみに歩いて帰らないでください。</b>
              一斉徒歩帰宅は救助活動の妨げになり、余震での落下物・沿道火災に晒されます。まず近くの
              <b>一時滞在施設</b>で待機し、鉄道の再開と安否確認を優先してください。
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {stranded.map((s) => (
                <li key={s.feature.properties.id} className="text-xs text-gray-800">
                  <a
                    href={gmapsWalkingUrl(origin, s.feature.geometry.coordinates as [number, number])}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-bold text-indigo-700 underline decoration-dotted underline-offset-2"
                  >
                    {s.feature.properties.name}
                  </a>
                  <span className="ml-1 text-gray-600">直線{s.km.toFixed(1)}km</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px] text-indigo-700">
              出典: 都立の一時滞在施設（東京都総務局）。区市町村・民間の施設は含みません。開設状況は必ず現地・公式情報で確認してください
            </p>
          </div>
        )}

        {/* 現在地の地震リスク（#106） */}
        {originQuakeLines.length > 0 && (
          <div className="rounded-lg border border-orange-300 bg-orange-50 p-3">
            <div className="text-xs font-bold text-orange-800">🌐 いまいる場所の地震リスク</div>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm text-orange-900">
              {originQuakeLines.map((line) => (
                <li key={line}>・{line}</li>
              ))}
            </ul>
          </div>
        )}

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

        {/* 浸水回避ルーティング(#38): 推奨避難所への経路の浸水曝露アドバイザリ。
            地震を想定しているときは洪水浸水想定の話が混乱を招くため出さない（代わりに延焼チェックを出す） */}
        {routeAdvisory && !isQuakeContext(attrs) && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              !routeAdvisory.floodKnown
                ? "border-gray-300 bg-gray-50 text-gray-700"
                : routeAdvisory.recommended.flood.maxDepthM > 0
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-green-300 bg-green-50 text-green-900"
            }`}
          >
            <div className="text-xs font-bold">🧭 避難経路の浸水チェック（推奨避難所まで）</div>
            {!routeAdvisory.floodKnown ? (
              <p className="mt-1">
                浸水想定データを読み込めなかったため、<b>浸水判定はできません</b>（経路のみ地図に表示）。
              </p>
            ) : routeAdvisory.recommended.flood.maxDepthM > 0 ? (
              <p className="mt-1">
                この経路は<b>浸水想定域を通過</b>します（想定最大浸水深{" "}
                <b>約{routeAdvisory.recommended.flood.maxDepthM}m</b>）。冠水時は迂回・垂直避難も検討してください。
              </p>
            ) : (
              <p className="mt-1">この経路は<b>浸水想定域を通りません</b>（想定区域図ベース）。</p>
            )}
            {routeAdvisory.floodKnown && routeAdvisory.avoidedFlood && (
              <p className="mt-1 text-[12px]">
                ✅ 最短経路（最大浸水深 約{routeAdvisory.shortest.flood.maxDepthM}m）より
                <b>浸水を避けられる経路</b>を地図に表示しています。
              </p>
            )}
            <p className="mt-1 text-[10px] text-gray-500">
              地図の
              {!routeAdvisory.floodKnown
                ? "灰の実線"
                : routeAdvisory.recommended.flood.maxDepthM > 0
                  ? "琥珀の破線"
                  : "緑の実線"}
              が経路（浸水域通過は破線・回避/判定不能は実線で色に頼らず区別）。出典: 東京都「浸水予想区域図」（CC BY 4.0）を粗いグリッドに集約。OSRMの代替経路から浸水曝露が最小のものを選択（経路自体の再計算は行いません）
            </p>
          </div>
        )}

        {/* 避難経路の地震リスク（#106）。浸水チェックの地震版 */}
        {quakeRouteAdvisory && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              (quakeRouteAdvisory.maxFireRank ?? 0) >= 4
                ? "border-red-300 bg-red-50 text-red-900"
                : "border-green-300 bg-green-50 text-green-900"
            }`}
          >
            <div className="text-xs font-bold">🔥 避難経路の延焼・液状化チェック</div>
            {(quakeRouteAdvisory.maxFireRank ?? 0) >= 4 ? (
              <p className="mt-1">
                この経路は<b>延焼の危険が高い地域</b>を通ります
                {quakeRouteAdvisory.worstChome && `（${quakeRouteAdvisory.worstChome}・火災危険度ランク${quakeRouteAdvisory.maxFireRank}）`}
                。煙や火が見えたら、無理に通らず広い道・広場側へ迂回してください。
              </p>
            ) : (
              <p className="mt-1">
                この経路が通るのは<b>延焼の危険が高い地域ではありません</b>
                （通過区間の最大 火災危険度ランク{quakeRouteAdvisory.maxFireRank ?? "—"}）。
              </p>
            )}
            {quakeRouteAdvisory.maxPL != null && quakeRouteAdvisory.maxPL > 5 && (
              <p className="mt-1 text-[12px]">
                経路上に<b>液状化の危険度が高い区間</b>があります（PL値 約
                {quakeRouteAdvisory.maxPL.toFixed(0)}）。段差・噴砂で車椅子やベビーカーが進めなくなる想定です。
              </p>
            )}
            <p className="mt-1 text-[10px] text-gray-500">
              地図の灰の実線が推奨避難所までの経路。経路上を約100m間隔でサンプリングし、通過する町丁目の地域危険度と250mメッシュの液状化想定を当てています。
            </p>
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
                あなたの状況と推奨避難先「{ranked[0].feature.properties.name}」に合わせ、
                {isQuakeContext(attrs)
                  ? "発災直後からの行動の手順を作成します（地震に警戒レベルはありません）"
                  : "警戒レベルに沿った避難の手順を作成します"}
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
                  <span className="text-[10px] text-gray-600">
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
                今の状況・現在地・言語をリンク/QRにします。受け取った人が開くと同じ避難先が表示されます。
                <span className="text-emerald-600">
                  （プライバシー配慮のため位置は約100m粒度。共有先の取り扱いにご注意ください）
                </span>
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
                    <span className="ml-1 text-gray-600">(道路距離)</span>
                  )}
                  {r.feature.properties.agingRate != null && (
                    <span className="ml-1 text-gray-600">
                      🧓 高齢化率{r.feature.properties.agingRate}%
                      {r.feature.properties.agingLevel === "chome" ? "(町丁目)" : ""}
                    </span>
                  )}
                  {/* 地震のときは、その避難先が建つ町丁目の延焼リスクを一目で分かるようにする */}
                  {r.quake?.fireRank != null && (
                    <span
                      className={`ml-1 ${r.quake.fireRank >= 4 ? "text-red-700" : "text-gray-600"}`}
                      title="地震に関する地域危険度測定調査（第9回）の火災危険度ランク"
                    >
                      🔥 延焼{RANK_LABEL[r.quake.fireRank]}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {/* スマホでは一覧と地図を同時に見られないので、カードから位置を確かめられるようにする */}
                  <button
                    onClick={() => {
                      setFocus({
                        id: r.feature.properties.id,
                        coordinates: r.feature.geometry.coordinates,
                        seq: focusSeq.current++,
                      });
                      setSnap("peek"); // 地図を広く見せる
                    }}
                    aria-label={`${r.feature.properties.name}を地図で見る`}
                    className="inline-flex min-h-[44px] items-center rounded border border-gray-300 px-2 text-gray-700 active:bg-gray-100 md:hidden"
                  >
                    📍 地図
                  </button>
                  <a
                    href={gmapsWalkingUrl(origin, r.feature.geometry.coordinates)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[44px] items-center rounded border border-blue-300 px-2 text-blue-700 hover:bg-blue-50"
                  >
                    🗺 ルート
                  </a>
                </span>
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
        {/* 重ねて見るレイヤー群。検索結果より下に置く。
            スマホでは画面が縦に短く、設定を先に並べると肝心の避難先までスクロールが要るため */}
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
          <p className="mt-1 text-[10px] text-gray-600">出典: ハザードマップポータルサイト(国土交通省)</p>
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
          <p className="mt-1 text-[10px] text-gray-600">
            建物: Project PLATEAU(国土交通省) CC BY 4.0。高いほど濃い緑＝上階避難に適す
          </p>
        </div>

        {/* 地震の危険度レイヤ（#106）。地震には重ねる浸水タイルが無いかわりに、
            町丁目の地域危険度と想定震度・液状化を面で見せる */}
        <div className="rounded-lg border border-gray-200 p-2">
          <div className="mb-1 text-xs font-bold text-gray-700">地震の危険度（町丁目）</div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                { key: "totalRank", label: "総合" },
                { key: "buildingRank", label: "建物倒壊" },
                { key: "fireRank", label: "火災（延焼）" },
              ] as const
            ).map((it) => {
              const on = quakeRiskLayer === it.key;
              return (
                <button
                  key={it.key}
                  onClick={() => setQuakeRiskLayer(on ? null : it.key)}
                  aria-pressed={on}
                  className={`rounded-full border px-2 py-1 text-xs ${
                    on
                      ? "border-red-500 bg-red-100 text-red-800"
                      : "border-gray-300 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {on ? "● " : "○ "}
                  {it.label}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(
              [
                { key: "shindo", label: "🌐 想定震度" },
                { key: "liquefaction", label: "💧 液状化" },
              ] as const
            ).map((it) => {
              const on = quakeGridLayer === it.key;
              return (
                <button
                  key={it.key}
                  onClick={() => setQuakeGridLayer(on ? null : it.key)}
                  aria-pressed={on}
                  className={`rounded-full border px-2 py-1 text-xs ${
                    on
                      ? "border-violet-500 bg-violet-100 text-violet-800"
                      : "border-gray-300 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {on ? "● " : "○ "}
                  {it.label}
                </button>
              );
            })}
          </div>
          {quakeRiskLayer && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-gray-600">
              <span>低</span>
              {["#fef9c3", "#fde68a", "#fb923c", "#ef4444", "#991b1b"].map((c, i) => (
                <span
                  key={c}
                  title={`ランク${i + 1}（${RANK_LABEL[i + 1]}）`}
                  className="inline-block h-2.5 w-5 rounded-sm"
                  style={{ backgroundColor: c }}
                />
              ))}
              <span>高</span>
              <span className="ml-1">ランク1〜5</span>
            </div>
          )}
          <p className="mt-1 text-[10px] text-gray-600">
            出典: 地震に関する地域危険度測定調査（第9回・東京都都市整備局）／首都直下地震等による東京の被害想定（令和4年度・東京都総務局）— CC BY
            4.0。想定震度・液状化は{quakeGrid?.scenario ?? "都心南部直下地震"}のケース。液状化データは沖積低地など対象地域のみ
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
            <button
              onClick={() => setShowAccessible((v) => !v)}
              aria-pressed={showAccessible}
              className={`rounded-full border px-2 py-1 text-xs ${
                showAccessible
                  ? "border-amber-500 bg-amber-100 text-amber-800"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100"
              }`}
            >
              {showAccessible ? "● " : "○ "}
              ♿ バリアフリー施設
            </button>
            <button
              onClick={() => setShowTempStay((v) => !v)}
              aria-pressed={showTempStay}
              className={`rounded-full border px-2 py-1 text-xs ${
                showTempStay
                  ? "border-indigo-500 bg-indigo-100 text-indigo-800"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100"
              }`}
            >
              {showTempStay ? "● " : "○ "}
              🏢 一時滞在施設
            </button>
          </div>
          <p className="mt-1 text-[10px] text-gray-600">
            出典: 東京都オープンデータ（災害時給水ステーション／FREE Wi-Fi & TOKYO／「だれでも東京」施設情報／都立の一時滞在施設）・都営バスGTFS（東京都交通局／ODPT）— CC BY 4.0。バス停は拡大で表示。バリアフリー施設は避難経路上で立ち寄れる休憩先。一時滞在施設は帰宅困難者の待機先（都立・住所を国土地理院APIでジオコーディング）
          </p>
        </div>

      </BottomSheet>

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

      {/* 地図。モバイルは全画面の背面（シートが上に重なる）、デスクトップは右カラム */}
      <main className="absolute inset-0 md:relative md:inset-auto md:min-h-0 md:flex-1">
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
          accessibleFacilities={accessibleFacilities}
          showAccessible={showAccessible}
          tempStay={tempStay}
          showTempStay={showTempStay}
          routeLine={routeLine}
          quakeRisk={quakeRisk}
          quakeRiskLayer={quakeRiskLayer}
          quakeGrid={quakeGrid}
          quakeGridLayer={quakeGridLayer}
          focus={focus}
        />
      </main>

      {/* モバイル: 地図が全画面になったぶん、現在地だけは常に見えるようにする。
          ノッチ・ステータスバーに潜らないよう safe-area を見込む */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden"
      >
        <span className="pointer-events-auto max-w-[92%] truncate rounded-full bg-white/95 px-3 py-1.5 text-xs text-gray-700 shadow-md">
          📍 {originLabel}
        </span>
      </div>

      {/* モバイル: 現在地取得のFAB。シートを畳んでいるときだけ出し、地図の操作を妨げない */}
      {snap === "peek" && (
        <button
          onClick={handleMyLocation}
          disabled={geoLoading}
          aria-label="現在地を取得する"
          className="absolute right-4 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-white text-xl shadow-lg active:bg-gray-100 disabled:opacity-50 md:hidden"
          // 畳んだシートのすぐ上に置く。高さは BottomSheet 側の定数を参照し、二重管理にしない
          style={{ bottom: `calc(${PEEK_VH}dvh + 0.75rem)` }}
        >
          {geoLoading ? "…" : "📍"}
        </button>
      )}
    </div>
  );
}
