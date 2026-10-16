/**
 * POST /api/claim/tx
 *
 * Build the unsigned creator-fee claim transaction for one pool.
 *
 * Request body (JSON):
 *   poolAddress      — required base58 DBC pool address
 *   creatorPublicKey — required base58 wallet that launched the pool (the
 *                      launch's payerPublicKey); becomes the fee payer
 *
 * 200 response:
 *   {
 *     transaction: string   // base64 legacy transaction, unsigned
 *     claimable: { quoteAtoms: string, baseAtoms: string }
 *     poolInfo: { poolAddress, configKey, baseMint, creator },
 *   }
 *
 * Errors:
 *   400 invalid request body       — { error: string }
 *   403 config_not_served          — { error, configKey }
 *   403 not_creator                — { error, creator }
 *   404 pool_not_found             — { error: "pool_not_found" }
 *   409 no_claimable_fees          — { error: "no_claimable_fees" }
 *   502 upstream/Solana failures   — { error: "upstream_error" }
 */
import { NextRequest, NextResponse } from 'next/server'
import { clientIpFromHeaders } from '@/lib/backend'
import { prepareClaimTx } from '@/lib/claim'
import { LaunchError } from '@/lib/launch'

export const runtime = 'nodejs'
// Claimable amounts change with every trade — never cache.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const clientIp = clientIpFromHeaders(req.headers)
  try {
    const body = await req.json().catch(() => null)
    return NextResponse.json(await prepareClaimTx(body, clientIp), {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (err) {
    if (err instanceof LaunchError) {
      return NextResponse.json(
        { error: err.fields.error ?? err.message, ...err.fields },
        { status: err.status, headers: { 'cache-control': 'no-store' } },
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/claim/tx]', message)
    // Generic body: upstream errors can embed the RPC URL (incl. API key).
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 })
  }
}
