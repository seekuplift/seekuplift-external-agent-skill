/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent Next.js from bundling Solana/Anchor packages — they need to run as Node.js CJS
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
