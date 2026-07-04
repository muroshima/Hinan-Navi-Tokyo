import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, TtlCache, stableKey } from "@/lib/rateLimit";

// 経路ジオメトリの共有キャッシュ（#21）。同一 origin×dest は結果が安定なので、公開OSRMデモへの
// 再問い合わせを避けて負荷を下げる。1hTTL・件数上限つき（インスタンス単位）。
type WalkRoute = { coordinates: [number, number][]; distM: number | null; durSec: number | null };
const walkCache = new TtlCache<WalkRoute[]>(500, 60 * 60_000);

// 出発地→避難先 の徒歩実経路ジオメトリ(+代替経路)をOSRM route serviceで取得(#38)。
// 既存の /api/route(table service=距離のみ)と別に、線形ジオメトリと複数代替を返す。
// body: { origin: [lng,lat], dest: [lng,lat] }
export async function POST(req: NextRequest) {
  // IP単位レート制限(OSRM公開デモサーバの酷使対策・#30)
  const limited = enforceRateLimit("walkroute", req, 30, 60_000);
  if (limited) return limited;

  let origin: [number, number] | undefined;
  let dest: [number, number] | undefined;
  try {
    const body = await req.json();
    origin = body?.origin;
    dest = body?.dest;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  // [lng,lat] かつ地理的に妥当な範囲(lng:-180..180 / lat:-90..90)か検証(範囲外はOSRMに投げず400で弾く)
  const isCoord = (c: unknown): c is [number, number] =>
    Array.isArray(c) &&
    c.length === 2 &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    Math.abs(c[0]) <= 180 &&
    Math.abs(c[1]) <= 90;
  if (!isCoord(origin) || !isCoord(dest)) {
    return NextResponse.json({ error: "origin and dest must be valid [lng,lat]" }, { status: 400 });
  }

  // キャッシュヒットなら公開OSRMを叩かず即返す
  const cacheKey = stableKey({ origin, dest });
  const cachedRoutes = walkCache.get(cacheKey);
  if (cachedRoutes) return NextResponse.json({ routes: cachedRoutes });

  const coords = `${origin[0]},${origin[1]};${dest[0]},${dest[1]}`;
  const url =
    `https://router.project-osrm.org/route/v1/foot/${coords}` +
    `?overview=full&geometries=geojson&alternatives=true`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ error: `osrm ${res.status}` }, { status: 502 });
    const j = await res.json();
    const routes = Array.isArray(j?.routes) ? j.routes : [];
    // 各点が有限数の [lng,lat] であることを検証(外部レスポンスの壊れた座標でNaN描画/解析を防ぐ)
    const isPt = (c: unknown): c is [number, number] =>
      Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);
    // 各経路の座標列(GeoJSON LineString)・距離・所要を返す。壊れた点を含む経路・点<2の経路は除外
    const out = routes
      .map((r: { geometry?: { coordinates?: unknown[] }; distance?: number; duration?: number }) => {
        const raw = Array.isArray(r.geometry?.coordinates) ? r.geometry!.coordinates : [];
        const coordinates = raw.every(isPt) ? (raw as [number, number][]) : [];
        return {
          coordinates,
          distM: typeof r.distance === "number" ? r.distance : null,
          durSec: typeof r.duration === "number" ? r.duration : null,
        };
      })
      .filter((r: { coordinates: unknown[] }) => r.coordinates.length >= 2);
    if (!out.length) return NextResponse.json({ error: "no route" }, { status: 404 });
    walkCache.set(cacheKey, out as WalkRoute[]);
    return NextResponse.json({ routes: out });
  } catch (err) {
    console.error("walkroute error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "routing failed" }, { status: 502 });
  }
}
