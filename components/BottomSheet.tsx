"use client";

// 操作パネル（#107）。スマホではボトムシート、デスクトップでは従来どおり左サイドバーとして振る舞う。
//
// 災害時に実際に使われるのはスマホで、片手・立ったまま・周囲を警戒しながらの操作になる。
// 地図を全画面に保ちつつ、必要な情報を必要なぶんだけ引き上げられるよう3段階でスナップする。
// 中身のDOMは1つだけ持ち、姿だけを画面幅で切り替える（同じ内容を2度描くとidが重複し、
// 支援技術にも二重に読まれるため）。
//
// ドラッグは「つまみ」でだけ受ける。コンテンツ側でも受けるとスクロールと競合し、
// 読もうとしてシートが閉じる・閉じようとしてスクロールする、という取り違えが起きる。

import { useCallback, useEffect, useRef, useState } from "react";

export type Snap = "collapsed" | "peek" | "half" | "full";

// シート全体の高さ（dvh）。iOS Safari のアドレスバー伸縮で跳ねないよう vh ではなく dvh を使う
const SHEET_HEIGHT = 88;
// 各スナップで見せる高さ（dvh）。peek でも入力欄と検索ボタンが収まる高さにする。
// collapsed はつまみだけを残して地図を最大限見せる段
const VISIBLE: Record<Snap, number> = { collapsed: 8, peek: 36, half: 62, full: SHEET_HEIGHT };

/** その段でシートが画面下に占める高さ（dvh）。地図に重ねるボタンの位置合わせに使う */
export function visibleVh(snap: Snap): number {
  return VISIBLE[snap];
}
// この距離までの動きはタップとみなす（px）。指は静止しているつもりでも数px動く
const TAP_THRESHOLD_PX = 8;
const ORDER: Snap[] = ["collapsed", "peek", "half", "full"];
const SNAP_LABEL: Record<Snap, string> = { collapsed: "最小", peek: "小", half: "中", full: "大" };

/**
 * consult = まだ検索していない状態。地図を出さず、相談欄だけを画面中央に置く。
 * result  = 検索後。モバイルはボトムシート、デスクトップは左サイドバーとして振る舞う。
 */
export type PanelMode = "consult" | "result";

interface Props {
  mode?: PanelMode;
  snap: Snap;
  onSnapChange: (snap: Snap) => void;
  /** デスクトップでのサイドバー幅(px)。モバイルでは無視する */
  desktopWidth?: number;
  children: React.ReactNode;
  /** つまみの下に出す補助表示（結果件数など） */
  handleLabel?: string;
  /** 値が変わると中身を先頭までスクロールする（検索し直したときなど） */
  scrollTopSignal?: number;
}

function offsetOf(snap: Snap): number {
  return SHEET_HEIGHT - VISIBLE[snap];
}

// ドラッグ終了位置（dvh単位のオフセット）から最も近いスナップを選ぶ
function nearestSnap(offset: number): Snap {
  let best: Snap = "peek";
  let bestDist = Infinity;
  for (const s of ORDER) {
    const d = Math.abs(offsetOf(s) - offset);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

// 境界を越えた分の抵抗。越えるほど動かなくなる。
// ぴたりと止めると「固まった」と感じるが、抵抗が続けば「ここで終わり」と伝わる
const RUBBER_MAX_VH = 4;
// 指が止まったと見なす間隔。これを超えて静止してから離したら勢いは無いものとする
const STOP_MS = 50;
// ドラッグ直後の click を無視する時間。click が来ないタッチ操作でも必ず解除する
const SUPPRESS_CLICK_MS = 350;
function rubberband(overshootVh: number) {
  const k = 0.55;
  const d = 24; // 抵抗が効き始める幅(dvh)
  return Math.min(RUBBER_MAX_VH, (overshootVh * d * k) / (d + k * Math.abs(overshootVh)));
}

// 指の勢いから「このまま滑ったらどこで止まるか」を出す（スクロールの慣性と同じ考え方）。
// 減速率 0.99 は端末のスクロールより短く止まる値。避難先を探す画面で
// 大きく飛びすぎると、狙った段に入れられない
function projectVh(velocityPxPerMs: number) {
  const decel = 0.99;
  const px = velocityPxPerMs * 1000 * (decel / (1 - decel)) / 1000;
  return (px / window.innerHeight) * 100;
}

// 掴んだ位置からの移動量を、シートの下端オフセット(dvh)に直す。
// 着地の判定は「指を離した位置」から直に計算する。React では pointermove が
// pointerup より低い優先度で処理されるため、負荷が高いと最後の move が後回しになり、
// 途中の値を着地点だと思い込んで段が変わらないことがあった（素早く弾くと再現した）
function offsetAt(clientY: number, d: { startY: number; startOffset: number; reduce: boolean }) {
  const deltaVh = ((clientY - d.startY) / window.innerHeight) * 100;
  const raw = d.startOffset + deltaVh;
  const min = 0;
  const max = offsetOf("collapsed");
  // collapsed より下、full より上は抵抗を付けて少しだけ動かす
  // 動きを控える設定では、境界を越えた弾みを出さずに止める
  if (d.reduce) return Math.min(max, Math.max(min, raw));
  if (raw < min) return min - rubberband(min - raw);
  if (raw > max) return max + rubberband(raw - max);
  return raw;
}

export default function BottomSheet({
  mode = "result",
  snap,
  onSnapChange,
  desktopWidth,
  children,
  handleLabel,
  scrollTopSignal,
}: Props) {
  // ドラッグ中だけ実オフセットを持ち、離したらスナップ位置へ戻す（null=ドラッグしていない）
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const dragging = useRef<{
    startY: number;
    startOffset: number;
    pointerId: number;
    // 離した瞬間の速度を出すための直近の位置と時刻。
    // 指の勢いを拾わないと、ゆっくり動かした距離だけで着地が決まり、
    // 素早く弾いても隣の段にしか行けない（フリックが効かない）
    lastY: number;
    lastT: number;
    velocity: number; // px/ms（下が正）
    // 掴んだ時点の「動きを控える」設定。ドラッグ中に変わることはないので固定でよい
    reduce: boolean;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // 畳んだら中身は先頭から読ませる（前回のスクロール位置に取り残さない）
  useEffect(() => {
    if ((snap === "peek" || snap === "collapsed") && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [snap]);

  // 検索し直したときなど、呼び出し側の指示で先頭へ戻す。
  // ボタンを押した直後はブラウザがフォーカス要素を見せようと勝手にスクロールするため、
  // 「何が起きたか」を頭から読ませるにはこちらから戻す必要がある
  useEffect(() => {
    if (scrollTopSignal != null && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [scrollTopSignal]);


  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return; // マウスの右クリック等は無視
      // 掴んだまま下へ動かすとブラウザがテキスト選択を始め、pointercancel でドラッグを
      // 奪ってしまう（下方向のドラッグだけが効かない原因だった）。既定の動作を止める。
      // 代わりにフォーカスは自分で移し、キーボード操作の起点は保つ
      e.preventDefault();
      (e.currentTarget as HTMLElement).focus();
      dragging.current = {
        startY: e.clientY,
        startOffset: offsetOf(snap),
        pointerId: e.pointerId,
        lastY: e.clientY,
        lastT: e.timeStamp,
        velocity: 0,
        reduce: reduceMotion,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragOffset(offsetOf(snap));
    },
    [snap, reduceMotion]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) {
      // 直近の1区間だけだと指の震えを拾うので、前の値と混ぜて滑らかにする
      const v = (e.clientY - d.lastY) / dt;
      d.velocity = d.velocity * 0.3 + v * 0.7;
      d.lastY = e.clientY;
      d.lastT = e.timeStamp;
    }
    setDragOffset(offsetAt(e.clientY, d));
  }, []);

  // ドラッグで着地させた直後は click を無視する。
  // pointerup のあとに click も発火するため、両方でスナップを変えると必ず1段ずれてしまう。
  // ただしタッチ操作では click が合成されないことがあり、降ろす機会が来ないまま
  // フラグが残ると「ドラッグの次の1タップが必ず死ぬ」。時間で必ず降ろす
  const suppressClick = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdSuppressClick = useCallback(() => {
    suppressClick.current = true;
    if (suppressTimer.current) clearTimeout(suppressTimer.current);
    suppressTimer.current = setTimeout(() => {
      suppressClick.current = false;
      suppressTimer.current = null;
    }, SUPPRESS_CLICK_MS);
  }, []);
  useEffect(() => () => {
    if (suppressTimer.current) clearTimeout(suppressTimer.current);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragging.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragging.current = null;
      const landed = offsetAt(e.clientY, d);
      setDragOffset(null);
      // 指がほとんど動いていなければタップ。スナップは変えず、続けて起きる click に任せる
      // （click 経由にしておくと、支援技術からの操作でも同じ動きになる）
      if (Math.abs(e.clientY - d.startY) < TAP_THRESHOLD_PX) return;
      holdSuppressClick();
      // 動きが止まってから離したら、勢いは無いものとして扱う。
      // pointermove は指が動いたときしか来ないので、素早く動かして途中で止めると
      // 速度が最後のフリックの値のまま残り、狙った位置に置いたはずが行き過ぎる
      const restedMs = e.timeStamp - d.lastT;
      const velocity = restedMs > STOP_MS ? 0 : d.velocity;
      // 離した位置ではなく、勢いのまま滑った先でスナップ先を決める。
      // 弱く動かせば隣の段、強く弾けば端まで飛ぶ
      onSnapChange(nearestSnap(landed + projectVh(velocity)));
    },
    [onSnapChange, holdSuppressClick]
  );

  // ポインタが奪われた場合(pointercancel)は操作そのものを無かったことにして元の段へ戻す。
  // cancel の座標は実際に指があった位置ではない（0が入る）ので、着地の計算には使えない。
  // click も発火しないため、抑制フラグも残さない
  const cancelDrag = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragging.current = null;
    setDragOffset(null);
  }, []);

  // つまみのタップ／Enter で次の段階へ。full の次は peek へ戻る。
  // 素早く2回叩かれても1段ずつ進むよう、次の値は ref で自前に進める。
  // props の snap をそのまま見ると、再レンダリング前の2回目が同じ遷移を繰り返してしまう
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  const cycle = useCallback(() => {
    const next = ORDER[(ORDER.indexOf(snapRef.current) + 1) % ORDER.length];
    snapRef.current = next;
    onSnapChange(next);
  }, [onSnapChange]);

  const offset = dragOffset ?? offsetOf(snap);

  return (
    <aside
      // transform/transition は CSS 変数で渡す。インラインの transform だと
      // デスクトップ(md:)のユーティリティで打ち消せず、サイドバーがずれてしまう
      style={
        {
          "--sheet-y": `${offset}dvh`,
          "--sheet-transition":
            dragOffset != null || reduceMotion
              ? "none"
              : "transform 260ms cubic-bezier(0.32,0.72,0,1)",
          ...(desktopWidth ? { "--sidebar-w": `${desktopWidth}px` } : {}),
        } as React.CSSProperties
      }
      className={
        mode === "consult"
          ? // 相談中: 地図を出さず、画面中央の1カラムに寄せる（読む幅を絞る）
            "mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col justify-center " +
            "bg-transparent md:h-auto md:w-full md:max-w-2xl"
          : // 結果表示中（モバイル）: 画面下に貼り付くシート
            "fixed inset-x-0 bottom-0 z-20 flex h-[88dvh] translate-y-[var(--sheet-y)] flex-col " +
            "rounded-t-2xl border-t border-slate-200 bg-slate-50 shadow-[0_-4px_24px_rgba(0,0,0,0.18)] " +
            "[transition:var(--sheet-transition)] " +
            // 結果表示中（デスクトップ）: 従来どおり左カラム
            "md:static md:z-auto md:h-[100dvh] md:w-[var(--sidebar-w,400px)] md:shrink-0 md:translate-y-0 " +
            "md:rounded-none md:border-t-0 md:border-r md:shadow-none md:[transition:none]"
      }
    >
      {/* つまみ（モバイルのみ）。ドラッグはここでだけ受ける */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`情報パネルの高さを変える（現在: ${SNAP_LABEL[snap]}）`}
        aria-expanded={snap === "full"}
        // ドラッグ中であることを外から見えるようにする（e2e が掴めたことを待てるように）
        data-dragging={dragOffset != null ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false; // ドラッグの後始末。次の click は通常どおり効かせる
            return;
          }
          cycle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            cycle();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            onSnapChange(ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(snap) + 1)]);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onSnapChange(ORDER[Math.max(0, ORDER.indexOf(snap) - 1)]);
          }
        }}
        // 縦ドラッグをブラウザのスクロールに取られないようにする
        className={`${mode === "consult" ? "hidden" : "flex"} min-h-[44px] shrink-0 cursor-grab touch-none flex-col items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 md:hidden`}
      >
        <span className="h-1.5 w-12 rounded-full bg-slate-300" />
        {handleLabel && <span className="mt-1 text-xs text-slate-500">{handleLabel}</span>}
      </div>

      {/* 中身。シート内のスクロールが背後へ連鎖しないよう overscroll を止める */}
      <div
        ref={scrollRef}
        // 中身のスクロール領域を「画面に見えているぶん」に収める。
        // シートは高さ固定を translateY で下げているので、これを指定しないと
        // スクロール領域の下端が画面外に残り、最後まで読めなくなる(#118)
        // 高さはCSS変数で渡す。インラインで max-height を直接指定すると
        // デスクトップの md:max-h-none で打ち消せず、サイドバーの下半分が切れる
        style={
          mode === "result"
            ? ({
                "--sheet-max-h": `calc(${VISIBLE[snap]}dvh - 44px)`,
                // ドラッグ中はアニメーションしない。高さが動くとつまみの位置もずれて、
                // 指の追従がぶれる（掴んだ場所と実際の位置が食い違う）
                "--sheet-max-h-transition":
                  dragOffset != null || reduceMotion
                    ? "none"
                    : "max-height 260ms cubic-bezier(0.32,0.72,0,1)",
              } as React.CSSProperties)
            : undefined
        }
        className={
          mode === "consult"
            ? "flex flex-col gap-4 px-5 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]"
            : "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] " +
              // スマホは見えているぶんだけをスクロール領域にする。デスクトップは制限しない
              "max-h-[var(--sheet-max-h)] [transition:var(--sheet-max-h-transition)] md:max-h-none md:[transition:none] md:p-4"
        }
      >
        {children}
      </div>
    </aside>
  );
}
