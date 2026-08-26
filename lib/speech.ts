// 読み上げ（SpeechSynthesis）の薄いラッパ。対応ブラウザのみ動作。
// 音声入力（Web Speech API）は使わない方針にしたため削除した(#118)
import type { Lang } from "./types";

// 出力言語 → 音声合成のBCP47ロケール
export const BCP47: Record<Lang, string> = {
  ja: "ja-JP",
  "ja-easy": "ja-JP",
  en: "en-US",
  zh: "zh-CN",
};

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
