import { NextRequest, NextResponse } from "next/server";

// 住所・地名 → 座標（OpenStreetMap Nominatim をサーバー経由で利用）
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&q=" +
    encodeURIComponent(q);

  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim利用ポリシー: 識別可能なUser-Agentを付与
        "User-Agent": "dare-hinan-navi/0.1 (Tokyo OpenData Hackathon prototype)",
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
