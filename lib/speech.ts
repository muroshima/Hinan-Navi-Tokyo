// Web Speech API（音声入力・読み上げ）の薄いラッパ。対応ブラウザのみ動作。
import type { Lang } from "./types";

// 出力言語 → 音声認識/合成のBCP47ロケール
export const BCP47: Record<Lang, string> = {
  ja: "ja-JP",
  "ja-easy": "ja-JP",
  en: "en-US",
  zh: "zh-CN",
};

interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SRCtor = new () => SpeechRecognitionLike;

// 音声認識インスタンスを生成（非対応環境では null）
export function createRecognition(lang: Lang): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = BCP47[lang];
  rec.interimResults = false;
  rec.continuous = false;
  return rec;
}

export function canRecognize(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// テキストを読み上げる（対応環境のみ）
export function speak(text: string, lang: Lang): void {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = BCP47[lang];
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
