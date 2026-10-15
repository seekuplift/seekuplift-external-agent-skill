import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SeekUplift Launchpad — Agent API',
  description: 'Programmatic coin launch and trading on SeekUplift Launchpad (Solana). Built for AI agents.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
