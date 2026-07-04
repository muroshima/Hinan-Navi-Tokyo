import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, TtlCache, stableKey } from "@/lib/rateLimit";

// 実経路(距離・所要)の共有キャッシュ（#21）。同一 origin×dests は結果が安定なので、
// 公開OSRMデモへの再問い合わせを避けて負荷を下げる。1hTTL・件数上限つき（インスタンス単位）。
type RouteCell = { distM: number | null; durSec: number | null };
const routeCache = new TtlCache<RouteCell[]>(500, 60 * 60_000);

// 出発地 → 複数候補 の徒歩実経路の距離・所要を OSRM table service でまとめて取得
// body: { origin: [lng,lat], dests: [[lng,lat], ...] }
export async function POST(req: NextRequest) {
  // IP単位レート制限（OSRM公開デモサーバの酷使対策・#30）
  const limited = enforceRateLimit("route", req, 30, 60_000);
  if (limited) return limited;

  let origin: [number, number] | undefined;
  let dests: [number, number][] = [];
  try {
    const body = await req.json();
    origin = body?.origin;
    dests = Array.isArray(body?.dests) ? body.dests.slice(0, 12) : [];
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // [lng,lat] かつ有限数の座標ペアか検証（不正入力でOSRMリクエストが壊れるのを防ぐ）
  const isCoord = (c: unknown): c is [number, number] =>
    Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);
  if (!isCoord(origin) || dests.length === 0 || !dests.every(isCoord)) {
    return NextResponse.json({ error: "origin and dests must be [lng,lat] pairs" }, { status: 400 });
  }

  // キャッシュヒットなら公開OSRMを叩かず即返す
  const cacheKey = stableKey({ origin, dests });
  const cachedResult = routeCache.get(cacheKey);
  if (cachedResult) return NextResponse.json({ result: cachedResult });

  const coords = [origin, ...dests].map((c) => `${c[0]},${c[1]}`).join(";");
  const url =
    `https://router.project-osrm.org/table/v1/foot/${coords}` +
    `?sources=0&annotations=distance,duration`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ error: `osrm ${res.status}` }, { status: 502 });
    const j = await res.json();
    const dist: unknown = j?.distances?.[0];
    const dur: unknown = j?.durations?.[0];
    // OSRM は HTTP 200 でも壊れたペイロード（distances 配列の欠落・長さ不足等）を返し得る。
    // 不正応答を「全null」で 1h キャッシュ固定しないよう検証し、満たさなければ 502 を返す
    // （クライアントは直線距離にフォールバックする）。index 0 は origin 自身なので dests+1 必要。
    if (!Array.isArray(dist) || dist.length < dests.length + 1) {
      return NextResponse.json({ error: "osrm malformed response" }, { status: 502 });
    }
    const durArr: unknown[] = Array.isArray(dur) ? dur : [];
    // index 0 は origin 自身なので 1 以降が dests に対応
    const result = dests.map((_, i) => ({
      distM: typeof dist[i + 1] === "number" ? (dist[i + 1] as number) : null,
      durSec: typeof durArr[i + 1] === "number" ? (durArr[i + 1] as number) : null,
    }));
    routeCache.set(cacheKey, result);
    return NextResponse.json({ result });
  } catch (err) {
    console.error("route error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "routing failed" }, { status: 502 });
  }
}
