import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/rateLimit";

// 住所・地名 → 座標（OpenStreetMap Nominatim をサーバー経由で利用）
export async function GET(req: NextRequest) {
  // IP単位レート制限（Nominatim公開サーバの酷使対策・#30）
  const limited = enforceRateLimit("geocode", req, 30, 60_000);
  if (limited) return limited;

  // 過大入力でNominatimに負荷をかけないよう長さを制限
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&q=" +
    encodeURIComponent(q);

  try {
    // Nominatim利用ポリシー: 連絡可能な情報をUser-Agent/Refererに含める（環境変数で設定、未設定でも動作）
    const contact = process.env.NOMINATIM_CONTACT_EMAIL;
    const ua = contact
      ? `dare-hinan-navi/0.1 (${contact})`
      : "dare-hinan-navi/0.1 (Tokyo OpenData Hackathon prototype)";
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        ...(contact ? { Referer: `mailto:${contact}` } : {}),
        "Accept-Language": "ja",
      },
      signal: AbortSignal.timeout(8000), // ネットワーク不調でぶら下がらないように
    });
    if (!res.ok) {
      return NextResponse.json({ error: `geocoder ${res.status}` }, { status: 502 });
    }
    const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!arr.length) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const hit = arr[0];
    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);
    // 不正な数値はクライアントの地図処理を壊すので弾く
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "invalid coordinates" }, { status: 502 });
    }
    return NextResponse.json({ lat, lng, label: hit.display_name });
  } catch (err) {
    console.error("geocode error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "geocoding failed" }, { status: 502 });
  }
}
