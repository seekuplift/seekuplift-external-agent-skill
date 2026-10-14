/**
 * LOCAL BACKEND integration check — the spec's "Local integration check
 * against a local backend: upload proxy works and a forwarded US IP gets an
 * idea launch refused." Gated on `LAUNCH_IT=1`; skipped in the offline suite.
 *
 * Requires:
 *   - backend-rs-sql running locally with Postgres, Filebase credentials, the
 *     geo_region_rules table loaded AND a GeoIP country DB — `BACKEND_URL`
 *     selects it (default http://localhost:3000; this worktree's dev backend
 *     ran on :3033). Without the GeoIP DB the backend fails open and the
 *     geo test skips.
 *   - mainnet RPC reachable — the tx build step hits it for the live config
 *     decode, blockhash, token-badge lookup and compute estimation.
 *
 * Run: LAUNCH_IT=1 BACKEND_URL=http://localhost:3033 \
 *        node --test tests/launch-integration.test.ts
 */
import { strict as assert } from 'node:assert'
import { describe, it, type TestContext } from 'node:test'
import { ComputeBudgetProgram, Keypair, Transaction } from '@solana/web3.js'
import { BackendHttpError } from '../src/lib/backend.ts'
import { BACKEND_URL } from '../src/lib/config.ts'
import { getConfigCatalogWithGeo } from '../src/lib/config-catalog.ts'
import { LaunchError, prepareLaunch } from '../src/lib/launch.ts'

/** A 1×1 transparent PNG — real bytes, sniffed as image/png. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A public US resolver IP — the local backend's GeoIP resolves it to US. */
const US_IP = '8.8.8.8'

const IT = process.env.LAUNCH_IT === '1'

async function requireBackend(t: TestContext): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (res.ok) return true
  } catch {
    // fall through
  }
  t.skip(`no local backend at ${BACKEND_URL} — start backend-rs-sql first`)
  return false
}

describe('local backend integration (LAUNCH_IT=1)', () => {
  it(
    'uploads image+metadata through the backend proxy and returns a mint-signed tx',
    { skip: IT ? false : 'set LAUNCH_IT=1 to run', timeout: 120_000 },
    async (t) => {
      if (!(await requireBackend(t))) return

      // Pick whatever live option the local backend serves for meme.
      const { configs } = await getConfigCatalogWithGeo('127.0.0.1')
      const entry = configs.find(
        (c) => c.categories.includes('meme') && !c.decodeError && c.quote.mint,
      )
      if (!entry) {
        t.skip('local backend catalog serves no decodable meme config')
        return
      }

      const payer = Keypair.generate().publicKey.toBase58()
      const body: Record<string, unknown> = {
        configKey: entry.configKey,
        category: 'meme',
        name: 'Agent IT Check',
        symbol: 'ait',
        description: 'integration check launch',
        image: PNG_1PX,
        payerPublicKey: payer,
      }
      // A cause-capable config requires a donation pick when causes are
      // offered; `managed` is always a selectable launch mode.
      if (entry.supportsCause) body.donation = { mode: 'managed' }

      const res = await prepareLaunch(body, '127.0.0.1')

      // Backend-proxy upload results surfaced on the response.
      assert.ok(res.imageUrl, 'image URL missing — proxy upload failed')
      assert.ok(res.metadataUrl, 'metadata URL missing — proxy upload failed')
      assert.equal(res.configKey, entry.configKey)
      assert.equal(res.category, 'meme')
      assert.equal(res.quoteMint, entry.quote.mint)
      assert.equal(res.firstBuyAtoms, null)

      // Legacy tx: mint-signed, payer slot open for the agent.
      const tx = Transaction.from(Buffer.from(res.transaction, 'base64'))
      const mintSig = tx.signatures.find(
        (s) => s.publicKey.toBase58() === res.mintAddress,
      )
      const payerSig = tx.signatures.find((s) => s.publicKey.toBase58() === payer)
      assert.ok(mintSig?.signature, 'mint keypair signature missing')
      assert.equal(payerSig?.signature ?? null, null, 'payer slot must stay unsigned')
      assert.ok(
        tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId)),
        'expected compute budget instructions',
      )
      assert.ok(res.poolAddress, 'pool address derived')
      assert.equal(tx.feePayer?.toBase58(), payer)

      // The uploaded metadata round-trips the app contract.
      const meta = (await (
        await fetch(res.metadataUrl, { signal: AbortSignal.timeout(15_000) })
      ).json()) as Record<string, unknown>
      assert.equal(meta.launchType, 'meme')
      assert.equal(meta.symbol, 'AIT')
      assert.equal(meta.image, res.imageUrl)
      assert.equal(meta.creatorAddress, payer)
      if (entry.supportsCause) {
        const funding = meta.donationFunding as { mode?: string } | undefined
        assert.equal(funding?.mode, 'managed')
      }
    },
  )

  it(
    'refuses a forwarded-US idea launch with geo_restricted BEFORE any upload',
    { skip: IT ? false : 'set LAUNCH_IT=1 to run', timeout: 60_000 },
    async (t) => {
      if (!(await requireBackend(t))) return

      // The service's own geo verdict (fresh from the backend mobile-config)
      // must resolve the forwarded US IP to an idea.create restriction;
      // without a GeoIP DB the backend fails open and this check skips.
      const { configs, geo } = await getConfigCatalogWithGeo(US_IP)
      if (geo.region !== 'US' || !geo.restricted.includes('idea.create')) {
        t.skip(
          `backend geo did not resolve ${US_IP} to US/idea.create ` +
            `(region=${geo.region}, restricted=${geo.restricted.join(',') || 'none'}) — ` +
            'is the GeoIP DB loaded?',
        )
        return
      }
      const entry = configs.find(
        (c) => c.categories.includes('idea') && !c.decodeError && c.quote.mint,
      )
      if (!entry) {
        t.skip('local backend catalog serves no decodable idea config')
        return
      }

      const payer = Keypair.generate().publicKey.toBase58()
      const err = await prepareLaunch(
        {
          configKey: entry.configKey,
          category: 'idea',
          name: 'Agent IT Geo',
          symbol: 'ageo',
          description: 'geo refusal check',
          image: PNG_1PX,
          payerPublicKey: payer,
          problem: 'does the refusal happen before uploads',
          useCases: ['other'],
          prototype: 'https://example.com/proto',
        },
        US_IP,
      ).then(
        () => null,
        (e: unknown) => e,
      )

      // The service's own pre-check refusal (LaunchError), NOT a backend
      // 403 surfaced after an upload — proving refusal consumed no upload
      // budget.
      assert.ok(err instanceof LaunchError, `expected LaunchError, got: ${String(err)}`)
      assert.ok(!(err instanceof BackendHttpError), 'refusal must precede any backend upload')
      assert.equal(err.status, 403)
      assert.equal(err.fields.error, 'geo_restricted')
      assert.equal(err.fields.region, 'US')
      assert.equal(err.fields.feature, 'idea.create')
    },
  )
})
