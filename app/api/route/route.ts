import { NextRequest, NextResponse } from "next/server";

// 出発地 → 複数候補 の徒歩実経路の距離・所要を OSRM table service でまとめて取得
// body: { origin: [lng,lat], dests: [[lng,lat], ...] }
export async function POST(req: NextRequest) {
  let origin: [number, number] | undefined;
  let dests: [number, number][] = [];
  try {
    const body = await req.json();
    origin = body?.origin;
    dests = Array.isArray(body?.dests) ? body.dests.slice(0, 12) : [];
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!origin || dests.length === 0) {
    return NextResponse.json({ error: "origin and dests required" }, { status: 400 });
  }

  const coords = [origin, ...dests].map((c) => `${c[0]},${c[1]}`).join(";");
  const url =
    `https://router.project-osrm.org/table/v1/foot/${coords}` +
    `?sources=0&annotations=distance,duration`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ error: `osrm ${res.status}` }, { status: 502 });
    const j = await res.json();
    const dist: (number | null)[] = j?.distances?.[0] ?? [];
    const dur: (number | null)[] = j?.durations?.[0] ?? [];
    // index 0 は origin 自身なので 1 以降が dests に対応
    const result = dests.map((_, i) => ({
      distM: dist[i + 1] ?? null,
      durSec: dur[i + 1] ?? null,
    }));
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
