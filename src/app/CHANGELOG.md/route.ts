import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

/** GET /CHANGELOG.md — the contract changelog both skill documents point at. */
export async function GET() {
  const changelog = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf-8')
  return new NextResponse(changelog, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
