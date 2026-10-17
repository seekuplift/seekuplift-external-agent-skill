/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent Next.js from bundling Solana/Anchor packages — they need to run as Node.js CJS.
  // Next 15: the stable top-level `serverExternalPackages` replaced
  // `experimental.serverComponentsExternalPackages` (the old key is ignored on 15 and
  // would silently bundle these). Next 16 keeps this key.
  serverExternalPackages: [
    '@meteora-ag/dynamic-bonding-curve-sdk',
    '@coral-xyz/anchor',
    '@solana/web3.js',
    'bn.js',
  ],
}

module.exports = nextConfig
