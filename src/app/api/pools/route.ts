import { NextRequest, NextResponse } from 'next/server'
import { BACKEND_URL, DBC_CONFIG_KEY } from '@/lib/config'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search') ?? ''
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100)

    let backendUrl: string
    if (search) {
      const params = new URLSearchParams({
        q: search,
        partnerConfigs: DBC_CONFIG_KEY,
        limit: String(limit),
      })
      backendUrl = `${BACKEND_URL}/api/stream/search?${params}`
    } else {
      const params = new URLSearchParams({
        partnerConfigs: DBC_CONFIG_KEY,
        limit: String(limit),
      })
      backendUrl = `${BACKEND_URL}/api/stream/recent?${params}`
    }

    const backendRes = await fetch(backendUrl, { next: { revalidate: 10 } })
    if (!backendRes.ok) {
      return NextResponse.json({ error: `Backend returned ${backendRes.status}` }, { status: 502 })
    }

    const raw: unknown = await backendRes.json()
    const items: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : []

    const pools = items.map((p) => {
      const base = p.baseAsset as Record<string, unknown> | undefined
      return {
        id: p.id,
        name: base?.name,
        symbol: base?.symbol,
        baseMint: base?.id,
        icon: base?.icon,
        price: p.price,
        marketCap: p.marketCap,
        volume24h: p.volume24h,
        priceChange24h: p.priceChange24h,
        graduated: p.graduated ?? false,
        createdAt: p.createdAt,
      }
    })

    return NextResponse.json({ pools })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/pools]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
