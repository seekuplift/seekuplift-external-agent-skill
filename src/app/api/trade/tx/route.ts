import { NextRequest, NextResponse } from 'next/server'
import { buildDbcSwapTx } from '@/lib/dbc-trade'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { poolAddress, side, amountIn, minimumAmountOut, ownerPublicKey } = body

    if (!poolAddress || !side || !amountIn || !minimumAmountOut || !ownerPublicKey) {
      return NextResponse.json(
        { error: 'Missing required fields: poolAddress, side, amountIn, minimumAmountOut, ownerPublicKey' },
        { status: 400 },
      )
    }
    if (side !== 'buy' && side !== 'sell') {
      return NextResponse.json({ error: 'side must be "buy" or "sell"' }, { status: 400 })
    }

    const swapBaseForQuote = side === 'sell'
    const result = await buildDbcSwapTx({
      poolAddress,
      ownerAddress: ownerPublicKey,
      swapBaseForQuote,
      amountIn: BigInt(amountIn),
      minimumAmountOut: BigInt(minimumAmountOut),
    })

    return NextResponse.json({
      ...result,
      note: 'Deserialize from base64 as a legacy Transaction, sign with ownerPublicKey, then submit to mainnet RPC.',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/trade/tx]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
