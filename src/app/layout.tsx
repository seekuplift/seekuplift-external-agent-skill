import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Meteora Launchpad — Agentic API',
  description: 'Programmatic token launch and trading on Meteora DBC (Solana). Built for AI agents.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
