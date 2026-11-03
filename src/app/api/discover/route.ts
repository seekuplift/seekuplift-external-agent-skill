/**
 * POST /api/discover
 *
 * Shortlist coins matching a user's stated interests — a thin forward to
 * the backend's POST /api/discover with the caller IP on X-Forwarded-For
 * (the backend's per-IP discover bucket and region exclusion resolve per
 * calling agent). The request shape is validated at the edge with the
 * backend's own limits; backend errors pass through unchanged.
 *
 * Request body (JSON):
 *   interests — required, 1-500 chars, any language (one short line
 *               summarizing the user's interests — no names or
 *               identifying details)
 *   avoid     — optional, <=5 terms of 1-80 chars
 *   filters   — optional { kind: cause|idea|any, causeSlugs: [] (<=50),
 *               stage: curve|graduated|any, minVolume24h: number >= 0 }
 *   sort      — optional relevance (default) | newest | active
 *   limit     — optional 1-25, default 10
 *   cursor    — optional nextCursor from a previous discover response
 *
 * 200 response (passed through from the backend):
 *   { mode: "semantic" | "keyword", results: [{ mint, name, symbol, kind,
 *     funds: { cause, project, idea }, marketCap, volume24h, stage,
 *     match, why }], excludedForRegion, nextCursor }
 *   marketCap/volume24h are display-grade — quote with /api/trade/quote
 *   before trading.
 *
 * Errors:
 *   400 { error: "invalid_request", field, message } — names the field
 *   401 unauthorized — unknown X-Api-Key (AGENT_API_KEYS)
 *   429 rate_limited — per-caller-network service limit
 *   502 upstream backend failure
 *
 * Privacy: the query text (interests/avoid) is never logged or stored —
 * error responses and log lines name fields and statuses only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkAgentAccess } from '@/lib/agent-auth'
import { BackendHttpError, clientIpFromHeaders } from '@/lib/backend'
import { discover } from '@/lib/discover'
import { LaunchError } from '@/lib/launch'

export const runtime = 'nodejs'
// Per-caller (per-IP read bucket, per-caller region exclusion) and
// time-sensitive — never cached anywhere.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Hidden until the backend half ships (CD-B-4): the route 404s and the
  // skill docs leave discover out. CD-B-4 sets DISCOVER_ENABLED=true and
  // reverts the docs-hiding commit.
  if (process.env.DISCOVER_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const clientIp = clientIpFromHeaders(req.headers)
  const access = checkAgentAccess(req.headers, clientIp)
  if (!access.ok) {
    return NextResponse.json(access.body, {
      status: access.status,
      headers: { 'cache-control': 'no-store', ...access.headers },
    })
  }
  try {
    const body = await req.json().catch(() => null)
    return NextResponse.json(await discover(body, clientIp), {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (err) {
    if (err instanceof LaunchError) {
      return NextResponse.json(
        { error: err.fields.error ?? err.message, ...err.fields },
        { status: err.status, headers: { 'cache-control': 'no-store' } },
      )
    }
    if (err instanceof BackendHttpError) {
      const body =
        err.body && typeof err.body === 'object' ? err.body : { error: err.message }
      return NextResponse.json(body as Record<string, unknown>, {
        status:
          err.status === 400 || err.status === 403 || err.status === 429 ? err.status : 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
    // Never log request data — a fixed message, not err.message: an
    // unexpected upstream error could embed request text in its message.
    console.error('[/api/discover] upstream failure')
    // Generic body: upstream errors can embed internals (incl. API keys).
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 })
  }
}
