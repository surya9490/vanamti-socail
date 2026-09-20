import { NextResponse } from 'next/server'

// ============================================================
// GET /api/health — liveness probe for Railway.
//
// Deliberately dependency-free: no DB, no Meta. Its only job is to
// tell Railway "the new container is serving HTTP" so it keeps the
// OLD container alive until this answers 200 (health-gated cut-over).
// Without a healthcheckPath Railway drains the old container the
// moment the new one starts, and every in-flight request — including
// the Vanamati app's notify sends — dies with a 502.
//
// A DB check here would make a Supabase blip fail deploys, which is
// the wrong trade: readiness ≠ dependency health.
// ============================================================

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    { ok: true, ts: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  )
}
