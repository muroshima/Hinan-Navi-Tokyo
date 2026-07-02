// Vertex AI Gemini クライアント（IAM認証・APIキー不要）。
// project が取得できない/認証が無い環境では null を返し、呼び出し側は語句一致fallbackに委ねる。
import { GoogleGenAI } from "@google/genai";

export const GEMINI_MODEL = "gemini-2.5-flash";

let cached: GoogleGenAI | null | undefined;

export function getGeminiClient(): GoogleGenAI | null {
  if (cached !== undefined) return cached;
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || "";
  const location = process.env.GCP_LOCATION || "asia-northeast1";
  if (!project) {
    cached = null; // プロジェクト未設定（ローカルでADC/ENV無し等）→ fallback
    return cached;
  }
  try {
    cached = new GoogleGenAI({ vertexai: true, project, location });
  } catch {
    cached = null;
  }
  return cached;
}
