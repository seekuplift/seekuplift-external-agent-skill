import { NextRequest, NextResponse } from 'next/server'
import { checkAgentAccess } from '@/lib/agent-auth'
import { clientIpFromHeaders } from '@/lib/backend'
import { LaunchError } from '@/lib/launch'
import { listPools } from '@/lib/pools'

export const runtime = 'nodejs'
// Pool reads are per-caller (the backend's per-IP read bucket) and
// time-sensitive — never cached anywhere.
export const dynamic = 'force-dynamic'

/**
 * GET /api/pools — list or search coins launched on any catalog config.
 *
 * Query params:
 *   search     optional — backend token search (name / symbol / mint).
 *              When present the call proxies `/api/stream/search`;
 *              otherwise `/api/stream/list`.
 *   limit      optional — results per page, 1..100 (default 20)
 *   cursor     optional — `nextCursor` from a previous list response
 *   tab        optional — "emerging" | "graduated" (list only)
 *   category   optional — "meme" | "idea" | "startup" (list only)
 *   lifecycle  optional — "new" (list only)
 *   sortBy     optional — "createdAt" (backend default) | "createdAtAsc" |
 *              "volume24h" | "marketCap" (list only)
 *
 * 200: { pools, nextCursor } — each pool carries its pool `id` (address),
 * name/symbol, USD `price`/`marketCap`/`volume24h`, the `graduated` flag
 * (trade graduated coins on Jupiter, not /api/trade/*) and the `configKey`
 * of the catalog config it launched on. Figures are display-grade.
 *
 * 400: { error } on an invalid limit/tab/category/lifecycle/sortBy.
 * 502: upstream backend failure.
 */
export async function GET(req: NextRequest) {
  const clientIp = clientIpFromHeaders(req.headers)
  const access = checkAgentAccess(req.headers, clientIp)
  if (!access.ok) {
    return NextResponse.json(access.body, {
      status: access.status,
      headers: { 'cache-control': 'no-store', ...access.headers },
    })
  }
  try {
    const { searchParams } = new URL(req.url)
    const result = await listPools(
      {
        search: searchParams.get('search'),
        limit: searchParams.get('limit'),
        cursor: searchParams.get('cursor'),
        tab: searchParams.get('tab'),
        category: searchParams.get('category'),
        lifecycle: searchParams.get('lifecycle'),
        sortBy: searchParams.get('sortBy'),
      },
      clientIp,
    )
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    if (err instanceof LaunchError) {
      return NextResponse.json(
        { error: err.fields.error ?? err.message, ...err.fields },
        { status: err.status, headers: { 'cache-control': 'no-store' } },
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/pools]', message)
    // Generic body: upstream errors can embed the RPC URL (incl. API key).
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 })
  }
}
