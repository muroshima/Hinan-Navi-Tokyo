import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/rateLimit";

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
  const isCoord = (c: unknown): c is [number, number] =>
    Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);
  if (!isCoord(origin) || !isCoord(dest)) {
    return NextResponse.json({ error: "origin and dest must be [lng,lat]" }, { status: 400 });
  }

  const coords = `${origin[0]},${origin[1]};${dest[0]},${dest[1]}`;
  const url =
    `https://router.project-osrm.org/route/v1/foot/${coords}` +
    `?overview=full&geometries=geojson&alternatives=true`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ error: `osrm ${res.status}` }, { status: 502 });
    const j = await res.json();
    const routes = Array.isArray(j?.routes) ? j.routes : [];
    // 各経路の座標列(GeoJSON LineString)・距離・所要を返す。座標が壊れた経路は除外
    const out = routes
      .map((r: { geometry?: { coordinates?: [number, number][] }; distance?: number; duration?: number }) => ({
        coordinates: Array.isArray(r.geometry?.coordinates) ? r.geometry!.coordinates : [],
        distM: typeof r.distance === "number" ? r.distance : null,
        durSec: typeof r.duration === "number" ? r.duration : null,
      }))
      .filter((r: { coordinates: unknown[] }) => r.coordinates.length >= 2);
    if (!out.length) return NextResponse.json({ error: "no route" }, { status: 404 });
    return NextResponse.json({ routes: out });
  } catch (err) {
    console.error("walkroute error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "routing failed" }, { status: 502 });
  }
}
