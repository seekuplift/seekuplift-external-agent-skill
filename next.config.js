/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent Next.js from bundling Solana/Anchor packages — they need to run as Node.js CJS.
  // MIGRATION NOTE (Next 15): `experimental.serverComponentsExternalPackages` is renamed
  // to the stable top-level `serverExternalPackages` — the experimental key only warns on
  // 15; move this list there when upgrading the Next major.
  experimental: {
    serverComponentsExternalPackages: [
      '@meteora-ag/dynamic-bonding-curve-sdk',
      '@coral-xyz/anchor',
      '@solana/web3.js',
      'bn.js',
    ],
  },
}

module.exports = nextConfig
