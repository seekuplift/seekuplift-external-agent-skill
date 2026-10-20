/**
 * POST /api/claim/tx
 *
 * Build the unsigned creator-fee claim transaction for one pool.
 *
 * Request body (JSON):
 *   poolAddress      — required base58 DBC pool address
 *   creatorPublicKey — required base58 wallet that launched the pool (the
 *                      launch's payerPublicKey); becomes the fee payer
 *   source           — optional "curve" (default) | "position". "curve" claims
 *                      the DBC creator fee buckets; "position" claims the
 *                      post-graduation fees of the creator's DAMM v2 position
 *                      NFT(s) in the coin's migrated pool. One transaction
 *                      per call — call twice to claim both.
 *
 * 200 response:
 *   {
 *     transaction: string   // base64 legacy transaction, unsigned
 *     claimable: { quoteAtoms: string, baseAtoms: string }
 *     poolInfo: { poolAddress, configKey, baseMint, creator },
 *     lastValidBlockHeight: number // expiry bound from the tx's blockhash read
 *     // source: "position" only: source, dammPool, positions: string[]
 *   }
 *   claimable reports the requested source only.
 *
 * Errors:
 *   400 invalid request body       — { error: string }
 *   403 config_not_served          — { error, configKey }
 *   403 not_creator                — { error, creator }
 *   404 pool_not_found             — { error: "pool_not_found" }
 *   409 no_claimable_fees          — { error } for "curve"; for "position"
 *                                    { error, reason: "no_creator_share" |
 *                                    "no_position_held" | "no_fees_accrued",
 *                                    dammPool } — only when the REQUESTED
 *                                    source is empty
 *   409 pool_not_migrated          — position: the coin has not graduated
 *   409 damm_pool_mismatch         — position: resolved pool's mints differ
 *   404 damm_pool_not_found        — position: resolved pool has no account
 *   422 unmapped_migration_fee_option / not_damm_v2_migration
 *                                  — position: the exact pool cannot be resolved
 *   502 upstream/Solana failures   — { error: "upstream_error" }
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkAgentAccess } from '@/lib/agent-auth'
import { clientIpFromHeaders } from '@/lib/backend'
import { prepareClaimTx } from '@/lib/claim'
import { LaunchError } from '@/lib/launch'

export const runtime = 'nodejs'
// Claimable amounts change with every trade — never cache.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
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
