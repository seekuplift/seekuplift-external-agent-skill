/**
 * POST /api/trade/quote
 *
 * Quote a buy or sell on a live DBC pool.
 *
 * Request body (JSON):
 *   poolAddress  — required base58 pool address (validated client-side)
 *   side         — "buy" (quote → base) or "sell" (base → quote), required
 *   amountIn     — required input atoms as a base-10 string
 *   slippageBps  — optional (default 50)
 *
 * 200 response:
 *   {
 *     amountOut: string             // expected output atoms
 *     minimumAmountOut: string      // output floor at the request's slippage
 *     baseTransferFeeAtomics: string // base-mint Token-2022 fee implied, "0" fee-free
 *     consumedInput: string         // gross input the curve consumed (partial buys < amountIn)
 *     amountLeft: string            // estimated gross refund for a partial-fill buy
 *     amountIn: string              // the request's input atoms
 *     slippageBps: number
 *     poolInfo: {                   // pool facts needed to read the quote
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
import { prepareTradeQuote } from '@/lib/trade'

export const runtime = 'nodejs'
// Geo verdicts are per-caller and computed fresh by the backend on every
// request — this route must never be cached anywhere.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const clientIp = clientIpFromHeaders(req.headers)
  try {
    const body = await req.json().catch(() => null)
    return NextResponse.json(await prepareTradeQuote(body, clientIp), {
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
    console.error('[/api/trade/quote]', message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
