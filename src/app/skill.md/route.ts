import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

/**
 * GET /skill.md — the FROZEN v1 contract (the path v1 agents cached).
 * Served until V1_CONTRACT_SUNSET; the current contract is /v2/skill.md.
 */
export async function GET() {
  const skillMd = readFileSync(join(process.cwd(), 'SKILL.v1.md'), 'utf-8')
  return new NextResponse(skillMd, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
