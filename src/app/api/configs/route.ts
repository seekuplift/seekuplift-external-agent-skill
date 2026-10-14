import { NextRequest, NextResponse } from 'next/server'
import { clientIpFromHeaders } from '@/lib/backend'
import { getConfigCatalog } from '@/lib/config-catalog'

export const runtime = 'nodejs'
// Geo verdicts are per-caller and computed fresh by the backend on every
// request — this route must never be cached anywhere.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const clientIp = clientIpFromHeaders(req.headers)
    const catalog = await getConfigCatalog(clientIp)
    return NextResponse.json(catalog, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/configs]', message)
    // Generic body: upstream errors can embed the RPC URL (incl. API key).
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 })
  }
}
