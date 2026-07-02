// 公開APIの悪用・コスト対策（#30）。IP単位の固定ウィンドウ・レート制限と、
// 冪等な生成結果の簡易TTLキャッシュを提供する。すべてプロセス内メモリで完結する。
//
// 【設計上の割り切り】Cloud Run は min-instances=0 / 複数インスタンスにスケールし得るため、
// この制限は「インスタンスごと」に効く（グローバル厳密ではない）。DoS完全防御ではなく、
// 単一クライアントの暴走・キー悪用によるコスト爆発を実用上抑えるのが目的。厳密なグローバル
// 制限が要るなら外部ストア（Redis等）が必要（ハッカソン用プロトタイプのため未導入）。
//
// NextRequest.ip は廃止されたため、Cloud Run のフロントが付与する x-forwarded-for（最左＝
// 直近クライアント）を用いる。ヘッダは詐称され得るのでベストエフォート。

import { NextResponse, type NextRequest } from "next/server";

type Hit = { count: number; resetAt: number };

// IP(＋ルート名) → ウィンドウ状態。無制限増加を防ぐため上限を設けて掃除する。
const buckets = new Map<string, Hit>();
const MAX_KEYS = 20_000; // 多数IP詐称によるメモリ枯渇の歯止め

// 期限切れエントリの定期掃除（インスタンス常駐時のメモリリーク防止）。
// unref でこのタイマーがプロセス終了を妨げないようにする。
let sweeper: ReturnType<typeof setInterval> | null = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }, 60_000);
  // Node ランタイムでのみ unref 可能（テスト・ビルド時にぶら下がらせない）
  (sweeper as { unref?: () => void }).unref?.();
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number; // 429時にRetry-Afterへ入れる秒数
};

// スライディングではなく固定ウィンドウ（軽量・十分）。limit回/windowMs をキー単位で許可。
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  ensureSweeper();
  const now = Date.now();
  let hit = buckets.get(key);

  if (!hit || hit.resetAt <= now) {
    // 新規キー追加前にメモリ上限を厳守（IP詐称で新規キーを投げ続けられてもMapを上限内に保つ）。
    // まず期限切れを掃除し、それでも埋まっていれば最古（Mapは挿入順＝リセットが近い順）を捨てる。
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      while (buckets.size >= MAX_KEYS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    hit = { count: 0, resetAt: now + windowMs };
    buckets.set(key, hit);
  }

  hit.count += 1;
  const remaining = Math.max(0, limit - hit.count);
  const retryAfterSec = Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
  return { ok: hit.count <= limit, remaining, retryAfterSec };
}

// x-forwarded-for の最左IP。無ければ "local"（開発・直アクセス）
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

// レート制限のキー（ルート名でバケットを分離し、ルートごとに独立して数える）
export function rateKey(route: string, req: NextRequest): string {
  return `${route}:${clientIp(req)}`;
}

// ルート先頭でのゲート。制限内なら null、超過なら 429(Retry-Afterヘッダ付き) を返す。
// 使い方: `const limited = enforceRateLimit("triage", req, 15, 60_000); if (limited) return limited;`
export function enforceRateLimit(
  route: string,
  req: NextRequest,
  limit: number,
  windowMs: number
): NextResponse | null {
  const r = rateLimit(rateKey(route, req), limit, windowMs);
  if (r.ok) return null;
  return NextResponse.json(
    { error: "rate limit exceeded" },
    { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } }
  );
}

// -------- 冪等な生成結果のTTLキャッシュ（triage/timeline のGeminiコスト削減） --------
// 同一入力の再問い合わせ（デモの再現操作・リロード等）でLLMを再度叩かないための簡易キャッシュ。
// FIFOで件数を制限し、TTLで陳腐化を防ぐ。

// キー順に依存しない安定したキャッシュキーを作る（再帰的にキーをソートしてstringify）。
// 同一内容が別キー扱いになってキャッシュミス（Gemini再呼び出し増）になるのを防ぐ。
export function stableKey(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

type CacheEntry<T> = { value: T; expireAt: number };

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(
    private maxEntries: number,
    private ttlMs: number
  ) {}

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): void {
    // 新規キーで上限超過時のみ最古（Mapは挿入順）を捨てる（既存キー更新では追い出さない）
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expireAt: Date.now() + this.ttlMs });
  }
}
