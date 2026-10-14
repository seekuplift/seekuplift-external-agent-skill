/**
 * Test helpers: decode captured on-chain fixtures through the REAL SDK
 * decoder (a stubbed Connection serving the captured account bytes), and
 * load the captured mobile-config payload.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { unwrapConfig } from '../src/lib/dbc-shared.ts'
import type { MobileConfigResponse } from '../src/lib/config-catalog.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T
}

/** The captured `/api/mobile-config?platform=web` response (production). */
export function mobileConfigFixture(overrides: Partial<MobileConfigResponse> = {}): MobileConfigResponse {
  return { ...loadFixture<MobileConfigResponse>('mobile-config.web.json'), ...overrides }
}

/**
 * Decode a captured `getAccountInfo` JSON-RPC response into the unwrapped
 * pool-config object, using the SDK's real anchor decoder behind a stubbed
 * connection.
 */
export async function decodePoolConfigFixture(
  name: string,
): Promise<Record<string, unknown> | null> {
  const fixture = loadFixture<{
    result: {
      value: {
        data: [string, string]
        executable: boolean
        lamports: number
        owner: string
        rentEpoch: number
      } | null
    }
  }>(name)
  const value = fixture.result.value
  const accountInfo = value
    ? {
        data: Buffer.from(value.data[0], 'base64'),
        executable: value.executable,
        lamports: value.lamports,
        owner: new PublicKey(value.owner),
        rentEpoch: value.rentEpoch,
      }
    : null
  const stubbedConnection = {
    getAccountInfo: async () => accountInfo,
    getAccountInfoAndContext: async () => ({
      context: { slot: 1 },
      value: accountInfo,
    }),
  }
  const client = new DynamicBondingCurveClient(stubbedConnection as never, 'confirmed')
  // The stubbed connection serves the fixture regardless of the key.
  const raw = await client.state.getPoolConfig(new PublicKey(LIVE_CONFIG_KEY))
  return raw == null ? null : unwrapConfig(raw)
}

/** The live production config (61UBwyZf…, SKR quote). */
export const LIVE_CONFIG_KEY = '61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv'
export const LIVE_CONFIG_ACCOUNT = 'pool-config-61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv.getAccountInfo.json'
/** The legacy config (4w9Rs2ew…, USDC quote, no first-buy flag). */
export const LEGACY_CONFIG_KEY = '4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT'
export const LEGACY_CONFIG_ACCOUNT = 'pool-config-4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT.getAccountInfo.json'

/** The production donation claim authority (app production manifest). */
export const DONATION_CLAIM_AUTHORITY = 'FdrDZPcYEjdB3nQGUgL7muXj4SBTzbAMMvMosufdtun1'
