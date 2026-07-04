import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, TtlCache } from "@/lib/rateLimit";

// ジオコーディング結果の共有キャッシュ（#21）。同じ地名は座標が安定なので、公開Nominatimへの
// 再問い合わせを避けて負荷を下げる。プロセス内メモリ・24hTTL・件数上限つき（インスタンス単位）。
type GeoHit = { lat: number; lng: number; label: string };
const geoCache = new TtlCache<GeoHit>(1000, 24 * 60 * 60_000);

// 住所・地名 → 座標（OpenStreetMap Nominatim をサーバー経由で利用）
export async function GET(req: NextRequest) {
  // IP単位レート制限（Nominatim公開サーバの酷使対策・#30）
  const limited = enforceRateLimit("geocode", req, 30, 60_000);
  if (limited) return limited;

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  // 過大入力は黙って切り詰めず明示的に弾く（切り詰めると別の住所を検索する誤動作になるため）
  if (q.length > 200) {
    return NextResponse.json({ error: "q is too long (max 200 chars)" }, { status: 400 });
  }

  // キャッシュヒットなら公開Nominatimを叩かず即返す（大小同一視のため小文字化キー）
  const cacheKey = q.toLowerCase();
  const cached = geoCache.get(cacheKey);
  if (cached) return NextResponse.json(cached);

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
    const payload: GeoHit = { lat, lng, label: hit.display_name };
    geoCache.set(cacheKey, payload); // 成功結果のみキャッシュ（404等は再問い合わせ余地を残す）
    return NextResponse.json(payload);
  } catch (err) {
    console.error("geocode error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "geocoding failed" }, { status: 502 });
  }
}
