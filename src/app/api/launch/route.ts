import { NextRequest, NextResponse } from 'next/server'
import { buildLaunchTx } from '@/lib/dbc'
import { uploadImageFromUrl, uploadMetadataJson } from '@/lib/ipfs'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, symbol, description, imageUrl, payerPublicKey, buyAmountSol } = body

    if (!name || !symbol || !imageUrl || !payerPublicKey) {
      return NextResponse.json(
        { error: 'Missing required fields: name, symbol, imageUrl, payerPublicKey' },
        { status: 400 },
      )
    }
    if (name.length < 3 || name.length > 32) {
      return NextResponse.json({ error: 'name must be 3–32 characters' }, { status: 400 })
    }
    if (symbol.length > 10) {
      return NextResponse.json({ error: 'symbol must be ≤10 characters' }, { status: 400 })
    }

    // 1. Upload image to IPFS
    const imgResult = await uploadImageFromUrl(imageUrl)

    // 2. Upload metadata JSON to IPFS
    const metadata = {
      name,
      symbol: symbol.toUpperCase(),
      description: description ?? '',
      image: imgResult.url,
    }
    const metaResult = await uploadMetadataJson(metadata)

    // 3. Build the launch transaction
    const buyAmountLamports = buyAmountSol && buyAmountSol > 0
      ? BigInt(Math.round(buyAmountSol * 1e9))
      : undefined

    const result = await buildLaunchTx({
      name,
      symbol,
      metadataUrl: metaResult.url,
      imageUrl: imgResult.url,
      payerAddress: payerPublicKey,
      buyAmountLamports,
    })

    return NextResponse.json({
      ...result,
      note: 'Deserialize from base64 as a legacy Transaction, sign with payerPublicKey, then submit to mainnet RPC.',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/launch]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
