import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

/** GET /skill.md — the contract (version 1.0.0). */
export async function GET() {
  const skillMd = readFileSync(join(process.cwd(), 'SKILL.md'), 'utf-8')
  return new NextResponse(skillMd, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
