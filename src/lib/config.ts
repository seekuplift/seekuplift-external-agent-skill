// Meteora DBC constants — mainnet only
export const DBC_CONFIG_KEY = '4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT'
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

export const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
  [NATIVE_MINT]: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
}

export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
export const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')

export const FILEBASE_API_KEY = process.env.FILEBASE_API_KEY || ''
export const FILEBASE_RPC_URL = 'https://rpc.filebase.io'
export const IPFS_GATEWAY_URL = (process.env.IPFS_GATEWAY_URL || 'https://ipfs.filebase.io/ipfs').replace(/\/$/, '')
