import { NextRequest, NextResponse } from 'next/server'
import { fetchDbcSwapQuote, fetchDbcPoolInfo } from '@/lib/dbc'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { poolAddress, side, amountIn, slippageBps } = body

    if (!poolAddress || !side || !amountIn) {
      return NextResponse.json(
        { error: 'Missing required fields: poolAddress, side, amountIn' },
        { status: 400 },
      )
    }
    if (side !== 'buy' && side !== 'sell') {
      return NextResponse.json({ error: 'side must be "buy" or "sell"' }, { status: 400 })
    }

    const poolInfo = await fetchDbcPoolInfo(poolAddress)
    if (poolInfo.isCompleted) {
      return NextResponse.json(
        { error: 'Pool has graduated to AMM. Use Jupiter API to trade this token.' },
        { status: 400 },
      )
    }

    // buy = quote→base (swapBaseForQuote: false), sell = base→quote (swapBaseForQuote: true)
    const swapBaseForQuote = side === 'sell'
    const quote = await fetchDbcSwapQuote({
      poolAddress,
      swapBaseForQuote,
      amountIn: BigInt(amountIn),
      slippageBps: slippageBps ?? 50,
    })

    return NextResponse.json({
      amountOut: quote.amountOut,
      minimumAmountOut: quote.minimumAmountOut,
      poolInfo: {
        quoteMint: poolInfo.quoteMint,
        quoteSymbol: poolInfo.quoteSymbol,
        isQuoteSol: poolInfo.isQuoteSol,
        isCompleted: poolInfo.isCompleted,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/trade/quote]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
