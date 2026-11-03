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
export const LIVE_CONFIG_KEY = 'DjLboXMLkQW9w7ZpcUPrKH1262GbwLZ2S7KNauu4B3fH'
export const LIVE_CONFIG_ACCOUNT = 'pool-config-DjLboXMLkQW9w7ZpcUPrKH1262GbwLZ2S7KNauu4B3fH.getAccountInfo.json'
/** The legacy config (4w9Rs2ew…, USDC quote, no first-buy flag). */
export const LEGACY_CONFIG_KEY = '4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT'
export const LEGACY_CONFIG_ACCOUNT = 'pool-config-4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT.getAccountInfo.json'

/** The tf-bootstrap default (Dird7tkG…: 1.25% + 1% transfer fee, creator 30%) and its claim PDA. */
export const TF_CONFIG_ACCOUNT = 'pool-config-Dird7tkGkKkmJW89PLME7PQ2jQaGJAftrUg4TPm9VoAx.getAccountInfo.json'
export const TF_CONFIG_FEE_CLAIMER = '6do3n9N3LcxP25Xuf7GVQHhN4zq34Q7JBwQn8bEJEvLA'

/** The default config's claim PDA (DjLboXML… feeClaimer, in .env.example's authorities). */
export const DONATION_CLAIM_AUTHORITY = '9vTeHSRDG13tZ1XT6cZHQYU1vLty6Jb3jrDyQv5BKovb'

/**
 * The vendored dbc-config production config record (TB-D-1), byte-for-byte.
 * Shared by every test that checks a config key against the record
 * (tests/config-record.test.ts; TB-S-4 reuses it for document claims).
 */
export type ConfigRecordKey = {
  key: string
  role: 'production' | 'partner' | 'test' | 'retired'
  default: boolean
  indexed: boolean
  quoteMint: string
  quoteSymbol: string
  quoteDecimals: number
  quoteTokenProgram: string
  /** The on-chain `feeClaimer` of this config, as recorded by TB-D-1. */
  feeClaimer: string
}
export type ConfigRecord = {
  schemaVersion: number
  dbcProgramId: string
  productionQuoteAllowlist: { mint: string; symbol: string; decimals: number; tokenProgram: string }[]
  keys: ConfigRecordKey[]
}
export function configRecord(): ConfigRecord {
  return loadFixture<ConfigRecord>('config-record.json')
}

/**
 * The partner config the recorded stream-list captures (2026-10-14) were taken
 * on. It is retired now, but those pool records are real captures; the pool
 * tests serve this key through an overlaid mobile-config so the captured
 * records stay unedited. Never an authority or launch config.
 */
export const POOLS_FIXTURE_CONFIG_KEY = '61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv'
export function poolsFixtureMobileConfig(): MobileConfigResponse {
  const option = { configKey: POOLS_FIXTURE_CONFIG_KEY, optionId: 'default' }
  return mobileConfigFixture({
    launchConfigKeys: { meme: POOLS_FIXTURE_CONFIG_KEY },
    launchConfigOptions: { meme: [option], idea: [option], startup: [option] },
    version: 'v-pools-fixture',
  })
}

/** An on-curve wallet address for tests that need a signer/payer (the claim PDA is off-curve). */
export const TEST_WALLET = 'FdrDZPcYEjdB3nQGUgL7muXj4SBTzbAMMvMosufdtun1'
