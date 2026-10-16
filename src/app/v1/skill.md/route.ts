import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

/** GET /v1/skill.md — explicit versioned path for the frozen v1 contract. */
export async function GET() {
  const skillMd = readFileSync(join(process.cwd(), 'SKILL.v1.md'), 'utf-8')
  return new NextResponse(skillMd, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
