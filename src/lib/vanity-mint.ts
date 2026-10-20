/**
 * Service-generated launch mints that end in "up".
 *
 * The backend grinds vanity keypairs and serves one per anonymous
 * `POST /api/launch/mint-keypair` (VM-1). This module fetches one and checks
 * it the way the app does: 64-byte secret, derived pubkey matches the claimed
 * one, address ends with `up`. Any failure throws; the caller falls back to a
 * plain `Keypair.generate()` and reports `mintVanity: false`.
 *
 * The secret is never logged: errors carry only a short reason string.
 */
import { Keypair } from '@solana/web3.js'
import { backendPostJson } from './backend.ts'

export const VANITY_SUFFIX = 'up'
export const VANITY_MINT_TIMEOUT_MS = 3000

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Minimal base58 decoder (the secret is the only 64-byte base58 we read). */
function decodeBase58(input: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of input) {
    let carry = B58.indexOf(ch)
    if (carry < 0) throw new Error('invalid base58')
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of input) {
    if (ch !== '1') break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

type MintKeypairResponse = { publicKey?: unknown; secretKey?: unknown }

/** Validate a backend mint-keypair response; throws a secret-free Error. */
export function parseVanityMintResponse(raw: unknown): Keypair {
  const body = (raw ?? {}) as MintKeypairResponse
  if (typeof body.publicKey !== 'string' || typeof body.secretKey !== 'string') {
    throw new Error('bad shape')
  }
  let secret: Uint8Array
  try {
    secret = decodeBase58(body.secretKey)
  } catch {
    throw new Error('bad secret encoding')
  }
  if (secret.length !== 64) throw new Error('secret is not 64 bytes')
  let keypair: Keypair
  try {
    keypair = Keypair.fromSecretKey(secret)
  } catch {
    throw new Error('secret does not round-trip')
  }
  const address = keypair.publicKey.toBase58()
  if (address !== body.publicKey) throw new Error('public key mismatch')
  if (!address.endsWith(VANITY_SUFFIX)) throw new Error('address does not end in up')
  return keypair
}

/**
 * Fetch a vanity mint keypair from the backend, forwarding the caller's
 * already-validated `clientIp` so the backend's per-network limit applies to
 * the agent rather than this server.
 */
export async function fetchVanityMint(clientIp: string | null): Promise<Keypair> {
  const raw = await backendPostJson<unknown>(
    '/api/launch/mint-keypair',
    {},
    { clientIp, timeoutMs: VANITY_MINT_TIMEOUT_MS },
  )
  return parseVanityMintResponse(raw)
}
