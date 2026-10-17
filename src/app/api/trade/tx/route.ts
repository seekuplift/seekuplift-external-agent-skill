/**
 * POST /api/trade/tx
 *
 * Build the unsigned-by-owner DBC swap transaction for a buy or sell.
 *
 * Request body (JSON):
 *   poolAddress      — required base58 pool address (validated client-side)
 *   ownerPublicKey   — required base58 owner wallet (becomes the fee payer)
 *   side             — "buy" (quote → base) or "sell" (base → quote), required
 *   amountIn         — required input atoms as a base-10 string
 *                      (≤ u64 max)
 *   minimumAmountOut — optional output atoms as a base-10 string; the
 *                      service ALWAYS recomputes the floor from a fresh
 *                      quote at `slippageBps` — a supplied value may only
 *                      TIGHTEN it (≥ the computed floor); a looser value
 *                      (incl. "0") is a 400 naming the floor
 *   slippageBps      — optional (default 50); 0–10000
 *
 * 200 response:
 *   {
 *     transaction: string          // base64 legacy transaction, unsigned
 *     amountIn: string             // the request's input atoms
 *     minimumAmountOut: string     // the floor the transaction was built with
 *     quote: {                     // the fresh quote behind the floor
 *       amountOut, minimumAmountOut, baseTransferFeeAtomics,
 *       consumedInput, amountLeft, amountIn, slippageBps,
 *     },
 *     poolInfo: {                  // the pool facts the tx was built against
 *       poolAddress, configKey, baseMint, baseDecimals,
 *       quoteMint, quoteDecimals, quoteSymbol, quoteScaledUiAmount,
 *       isQuoteSol, baseTransferFee, migrationState, isCompleted,
 *     },
 *     lastValidBlockHeight: number // expiry bound from the tx's blockhash read
 *   }
 *
 * Errors:
 *   400 invalid request body     — { error: string }
 *   401 unauthorized             — missing/unknown X-Api-Key (AGENT_API_KEYS)
 *   403 geo_restricted           — { error: "geo_restricted", region, feature }
 *   404 pool_not_found           — { error: "pool_not_found" }
 *   409 pool_not_tradeable       — { error, migrationState, retryable }
 *   429 rate_limited             — { error: "rate_limited", retryAfter }
 *   500 upstream/Solana failures — { error: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkAgentAccess } from '@/lib/agent-auth'
import { BackendHttpError, clientIpFromHeaders } from '@/lib/backend'
import { LaunchError } from '@/lib/launch'
import { prepareTradeTx } from '@/lib/trade'

export const runtime = 'nodejs'
// Geo verdicts are per-caller and computed fresh by the backend on every
// request — this route must never be cached anywhere.
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
    return NextResponse.json(await prepareTradeTx(body, clientIp), {
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
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/trade/tx]', message)
    // Generic body: upstream errors can embed the RPC URL (incl. API key).
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 })
  }
}
