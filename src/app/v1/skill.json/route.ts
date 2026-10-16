import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

/**
 * GET /v1/skill.json — explicit versioned path for the frozen v1
 * machine-readable contract (the same bytes as /skill.json).
 */
export async function GET() {
  const skillJson = readFileSync(join(process.cwd(), 'public', 'skill.json'), 'utf-8')
  return new NextResponse(skillJson, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
