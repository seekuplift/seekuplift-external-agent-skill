import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

export async function GET() {
  const skillMd = readFileSync(join(process.cwd(), 'SKILL.md'), 'utf-8')
  return new NextResponse(skillMd, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
