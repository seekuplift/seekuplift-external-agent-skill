import { NextRequest, NextResponse } from 'next/server'
import { BackendHttpError, clientIpFromHeaders } from '@/lib/backend'
import { LaunchError, prepareLaunch } from '@/lib/launch'

export const runtime = 'nodejs'
// Geo verdicts are per-caller and computed fresh by the backend on every
// request — this route must never be cached anywhere.
export const dynamic = 'force-dynamic'

/**
 * POST /api/launch — build the unsigned-by-payer, mint-partial-signed DBC
 * launch transaction on an agent-chosen config from `GET /api/configs`.
 *
 * Body (JSON):
 *   configKey       required — a live config key from GET /api/configs
 *   category        required — "meme" | "idea" | "startup"; the config must
 *                   be offered for it
 *   name/symbol/description  required — app identity limits apply
 *   image           required — base64 bytes (optionally a data: URL); the
 *                   service uploads through the backend proxy. `imageUrl`
 *                   is rejected (remote fetching is a later ticket).
 *   payerPublicKey  required — the wallet that will sign + fund the launch;
 *                   also recorded as creatorAddress in the metadata
 *   donation        meme-only, cause-capable configs only, REQUIRED while
 *                   /api/causes offers picks: { mode, cause?, project?,
 *                   handle?, redditUserId? }
 *   ideaFunding     idea-only: { mode, address?, handle?, redditUserId? }
 *   firstBuyAtoms | firstBuyAmount — optional creator first buy, only on
 *                   configs with supportsFirstBuy (display amounts convert
 *                   with fresh quote decimals + the ScaledUiAmount
 *                   multiplier — never a fixed 1e9)
 *   idea/startup extras: problem, useCases, prototype, deck, whitepaper,
 *                   links (website/twitter/telegram/discord), and the
 *                   startup compliance fields.
 */
export async function POST(req: NextRequest) {
  const clientIp = clientIpFromHeaders(req.headers)
  try {
    const body = await req.json().catch(() => null)
    const result = await prepareLaunch(body, clientIp)
    return NextResponse.json(
      {
        transaction: result.transaction,
        mintAddress: result.mintAddress,
        poolAddress: result.poolAddress,
        metadataUrl: result.metadataUrl,
        imageUrl: result.imageUrl,
        configKey: result.configKey,
        category: result.category,
        quoteMint: result.quoteMint,
        firstBuyAtoms: result.firstBuyAtoms,
        note: 'Deserialize from base64 as a legacy Transaction, sign with payerPublicKey, then submit to mainnet RPC. The mint keypair signature is already applied.',
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (err) {
    if (err instanceof LaunchError) {
      return NextResponse.json(
        { error: err.fields.error ?? err.message, ...err.fields },
        { status: err.status, headers: { 'cache-control': 'no-store' } },
      )
    }
    if (err instanceof BackendHttpError) {
      // The backend's own refusal (rate limit, geo refusal that slipped the
      // pre-check) — surface its status and error body unchanged.
      const body =
        err.body && typeof err.body === 'object'
          ? err.body
          : { error: err.message }
      return NextResponse.json(body as Record<string, unknown>, {
        status: err.status === 400 || err.status === 403 || err.status === 429 ? err.status : 502,
        headers: { 'cache-control': 'no-store' },
      })
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/launch]', message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
