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

export type Snap = "peek" | "half" | "full";

// シート全体の高さ（dvh）。iOS Safari のアドレスバー伸縮で跳ねないよう vh ではなく dvh を使う
const SHEET_HEIGHT = 88;
/** 畳んだ状態でシートが占める高さ（dvh）。この上に重ねるもの（FAB等）が位置合わせに使う */
export const PEEK_VH = 36;
// 各スナップで見せる高さ（dvh）。peek でも入力欄と検索ボタンが収まる高さにする
const VISIBLE: Record<Snap, number> = { peek: PEEK_VH, half: 62, full: SHEET_HEIGHT };
// この距離までの動きはタップとみなす（px）。指は静止しているつもりでも数px動く
const TAP_THRESHOLD_PX = 8;
const ORDER: Snap[] = ["peek", "half", "full"];
const SNAP_LABEL: Record<Snap, string> = { peek: "小", half: "中", full: "大" };

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
  const dragging = useRef<{ startY: number; startOffset: number; pointerId: number } | null>(null);
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
    if (snap === "peek" && scrollRef.current) scrollRef.current.scrollTop = 0;
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
      dragging.current = { startY: e.clientY, startOffset: offsetOf(snap), pointerId: e.pointerId };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragOffset(offsetOf(snap));
    },
    [snap]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const deltaVh = ((e.clientY - d.startY) / window.innerHeight) * 100;
    // peek より下、full より上へは行かせない
    const next = Math.min(offsetOf("peek"), Math.max(0, d.startOffset + deltaVh));
    setDragOffset(next);
  }, []);

  // ドラッグで着地させた直後は click を無視する。
  // pointerup のあとに click も発火するため、両方でスナップを変えると必ず1段ずれてしまう
  const suppressClick = useRef(false);

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragging.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragging.current = null;
      const landed = dragOffset;
      setDragOffset(null);
      // 指がほとんど動いていなければタップ。スナップは変えず、続けて起きる click に任せる
      // （click 経由にしておくと、支援技術からの操作でも同じ動きになる）
      if (Math.abs(e.clientY - d.startY) < TAP_THRESHOLD_PX) return;
      suppressClick.current = true;
      if (landed != null) onSnapChange(nearestSnap(landed));
    },
    [dragOffset, onSnapChange]
  );

  // ポインタが奪われた場合(pointercancel)は click が発火しないので、抑制フラグを残さない
  const cancelDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragging.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragging.current = null;
      const landed = dragOffset;
      setDragOffset(null);
      if (landed != null) onSnapChange(nearestSnap(landed));
    },
    [dragOffset, onSnapChange]
  );

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
              : "transform 240ms cubic-bezier(0.4,0,0.2,1)",
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
        style={
          mode === "result"
            ? {
                maxHeight: `calc(${VISIBLE[snap]}dvh - 44px)`,
                // ドラッグ中はアニメーションしない。高さが動くとつまみの位置もずれて、
                // 指の追従がぶれる（掴んだ場所と実際の位置が食い違う）
                transition:
                  dragOffset != null || reduceMotion
                    ? "none"
                    : "max-height 240ms cubic-bezier(0.4,0,0.2,1)",
              }
            : undefined
        }
        className={
          mode === "consult"
            ? "flex flex-col gap-4 px-5 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]"
            : "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:max-h-none md:p-4"
        }
      >
        {children}
      </div>
    </aside>
  );
}
