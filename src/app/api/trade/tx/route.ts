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
 *   minimumAmountOut — optional output atoms as a base-10 string; omitted →
 *                      the service quotes internally at `slippageBps`
 *                      (default 50), so a one-call agent still gets the app's
 *                      floor math
 *   slippageBps      — optional (default 50); only used for that internal
 *                      quote — the transaction itself takes minimumAmountOut
 *                      verbatim
 *
 * 200 response:
 *   {
 *     transaction: string          // base64 legacy transaction, unsigned
 *     amountIn: string             // the request's input atoms
 *     minimumAmountOut: string     // the floor the transaction was built with
 *     quote: {                     // present only when the route quoted internally
 *       amountOut, minimumAmountOut, baseTransferFeeAtomics,
 *       consumedInput, amountLeft, amountIn, slippageBps,
 *     } | null,
 *     poolInfo: {                  // the pool facts the tx was built against
 *       poolAddress, configKey, baseMint, baseDecimals,
 *       quoteMint, quoteDecimals, quoteSymbol, quoteScaledUiAmount,
 *       isQuoteSol, baseTransferFee, migrationState, isCompleted,
 *     },
 *   }
 *
 * Errors:
 *   400 invalid request body     — { error: string }
 *   403 geo_restricted           — { error: "geo_restricted", region, feature }
 *   404 pool_not_found           — { error: "pool_not_found" }
 *   409 pool_not_tradeable       — { error, migrationState, retryable }
 *   500 upstream/Solana failures — { error: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { BackendHttpError, clientIpFromHeaders } from '@/lib/backend'
import { LaunchError } from '@/lib/launch'
import { prepareTradeTx } from '@/lib/trade'

export const runtime = 'nodejs'
// Geo verdicts are per-caller and computed fresh by the backend on every
// request — this route must never be cached anywhere.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const clientIp = clientIpFromHeaders(req.headers)
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
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
