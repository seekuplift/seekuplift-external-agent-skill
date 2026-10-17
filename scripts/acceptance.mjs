#!/usr/bin/env node
/**
 * scripts/acceptance.mjs — real-coin acceptance for the SeekUplift Launchpad
 * agent skill (ticket 09).
 *
 * Drives the deployed service exactly the way an agent following SKILL.md
 * would: one step per advertised capability, failing on the first miss.
 *
 *   1. fetch /skill.md + /skill.json — the capability list drives the run;
 *      a capability with no step below fails the run (script and SKILL.md
 *      stay one-to-one).
 *   2. GET /api/configs — the memecoin default (defaultFor:["meme"]) must be
 *      a creator-fee config (fees.creatorSharePct > 0, not allFeesToCause).
 *   3. POST /api/launch — with a first buy when the config supports it.
 *      Donation is resolved the way an agent would: post without it, and on
 *      400 { error: "donation_required" } re-post with the first offered
 *      shipping cause.
 *   4. GET /api/pools — find the new coin via BOTH search and list.
 *   5. Anti-sniper wait — trades are held until the launch config's fee
 *      decay window (fees.curve.decaySecondsEstimate) has passed, so the
 *      trade does not pay the opening fee.
 *   6. buy:  POST /api/trade/quote → POST /api/trade/tx → sign → send →
 *      confirm → balances moved as quoted within slippage.
 *   7. sell: same for part of the purchased base balance.
 *
 * MODES
 *
 *   --dry-run (default when --send is absent)
 *     Executes every READ-ONLY step: docs fetch, configs check, launch tx
 *     BUILD (the endpoint uploads the image + metadata through the backend
 *     — two upload-budget slots, real IPFS objects, but no funds and no
 *     on-chain coin because the tx is never signed or sent), pools
 *     search/list shape checks, trade quotes + unsigned tx builds against
 *     an existing curve pool, and read-only mainnet simulation of the built
 *     transactions (sigVerify off). Every sign/send/confirm is skipped with
 *     a printed [SKIP-SEND] marker. Pass --no-launch-build to make the dry
 *     run purely read-only (no upload slots spent).
 *
 *   --send  REAL MODE — SPENDS FUNDS, SENDS MAINNET TRANSACTIONS.
 *     Refuses unless ALL hold:
 *       a. the approval file exists and its planHash equals the sha256 "plan
 *          hash" of the FULL resolved run plan (config key, name, symbol,
 *          description, image sha256, first buy, buy amount, sell rule,
 *          slippage, donation cause, base URL, payer). Run --dry-run to see
 *          the plan + hash (default file ./acceptance-approval.json, override
 *          with ACCEPTANCE_APPROVAL_FILE). Format:
 *            { "approved": true, "planHash": "<sha256 hex>",
 *              "approvedBy": "<owner>", "approvedAt": "<iso>" }
 *          Any change to any plan field (incl. env overrides) changes the hash
 *          and voids the approval.
 *       b. --dry-run is NOT also passed.
 *       c. the base URL is https://skill.seekuplift.com, unless
 *          ACCEPTANCE_ALLOW_LOCAL_SEND=yes is set (deployed service only).
 *       d. the payer holds enough SOL and quote token for the plan (checked
 *          before anything is sent).
 *     Every signature is printed and written to the report file, which is
 *     persisted after every step and right after the launch confirms.
 *
 *   --resume <report.json> (or ACCEPTANCE_POOL=<pool>) with --send
 *     Skips the launch and continues from the recorded pool (verified to exist
 *     on-chain). Still requires the same approval; the report's planHash must
 *     match. A second coin is never launched when a prior report for this
 *     planHash already records a launched mint.
 *
 * USAGE
 *   node scripts/acceptance.mjs --dry-run --base-url http://localhost:3001
 *   node scripts/acceptance.mjs --send --base-url https://skill.seekuplift.com
 *
 * ENV
 *   ACCEPTANCE_BASE_URL      service base URL (default https://skill.seekuplift.com)
 *   ACCEPTANCE_KEYPAIR       path to a Solana keypair JSON file (byte array).
 *                            Dry-run falls back to ACCEPTANCE_SIM_PAYER, else an
 *                            ephemeral keypair, when unset; --send refuses without it.
 *   ACCEPTANCE_SIM_PAYER     dry-run only: a funded mainnet PUBLIC key to build and
 *                            simulate as (nothing is signed), so simulations must
 *                            come back clean instead of failing on an unfunded payer
 *   ACCEPTANCE_RPC           Solana mainnet RPC (default SOLANA_RPC_URL or
 *                            https://api.mainnet-beta.solana.com); logged and
 *                            reported as scheme+host only
 *   AGENT_API_KEY            X-Api-Key credential (<id>:<secret>) for the
 *                            builder endpoints (or --api-key); required when
 *                            the target service has AGENT_API_KEYS set
 *   ACCEPTANCE_POOL          resume from this pool address (see --resume)
 *   ACCEPTANCE_DONATION_CAUSE  pin the donation cause slug instead of
 *                            auto-picking causesOffered[0] (part of the plan)
 *   ACCEPTANCE_APPROVAL_FILE approval file path (default ./acceptance-approval.json)
 *   ACCEPTANCE_REPORT        report output path (default ./acceptance-report-<ts>.json)
 *   ACCEPTANCE_IMAGE         path to a PNG/JPEG to upload instead of the
 *                            generated acceptance image
 *   ACCEPTANCE_COIN_NAME / ACCEPTANCE_COIN_SYMBOL / ACCEPTANCE_COIN_DESC
 *                            override the proposed coin details (part of the plan
 *                            hash, so --send needs a fresh approval)
 *   ACCEPTANCE_FIRST_BUY     first-buy amount in quote display units
 *                            (default: the config's quote.firstBuyDefault)
 *   ACCEPTANCE_BUY_AMOUNT    buy amount in quote display units (default 10)
 *   ACCEPTANCE_SELL_BPS      share of the purchased base balance to sell
 *                            (default 5000 = 50%)
 *   ACCEPTANCE_SLIPPAGE_BPS  trade slippage (default 100)
 *   ACCEPTANCE_ALLOW_LOCAL_SEND=yes  permit --send against a loopback URL
 *
 * Exit code 0 = every executed step passed; 1 = first miss (details in the
 * report file and on stdout).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'

// ─── Proposed coin details (docs/acceptance-coin-proposal.md) ─────────────────
// The approval file must match these exactly in --send mode — changing the
// coin invalidates the owner's approval, which is the point.
const COIN = {
  // Brand-neutral on purpose: the backend refuses names/symbols that echo the
  // platform brand (422 brand_impersonation) — found by the dry-run.
  name: process.env.ACCEPTANCE_COIN_NAME || 'Skill Acceptance Coin',
  symbol: process.env.ACCEPTANCE_COIN_SYMBOL || 'SKACC',
  description:
    process.env.ACCEPTANCE_COIN_DESC ||
    'Real-coin acceptance launch for the launchpad agent skill: ' +
      'one creator-fee memecoin launched, found, bought and sold end-to-end by ' +
      'scripts/acceptance.mjs after owner approval.',
  category: 'meme',
}
const BUY_AMOUNT_DISPLAY = process.env.ACCEPTANCE_BUY_AMOUNT || '10'
const SELL_BPS = Number(process.env.ACCEPTANCE_SELL_BPS || '5000')
const SLIPPAGE_BPS = Number(process.env.ACCEPTANCE_SLIPPAGE_BPS || '100')
const ANTI_SNIPER_MARGIN_SECONDS = 60
const ANTI_SNIPER_MARGIN_SLOTS = 150
const PROD_BASE_URL = 'https://skill.seekuplift.com'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
// SOL the payer needs beyond the config's pool-creation fee: mint/metadata/pool
// rent, ATAs, network fees for launch + buy + sell. Resume needs only trades.
const SOL_MARGIN_LAUNCH_LAMPORTS = 30_000_000n
const SOL_MARGIN_TRADES_LAMPORTS = 10_000_000n
const QUOTE_MARGIN_BPS = 100n // +1% on quote-token spend

// ─── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    baseUrl: null,
    dryRun: false,
    send: false,
    rpc: null,
    report: null,
    approval: null,
    resume: null,
    image: null,
    apiKey: null,
    launchBuild: true,
    help: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => argv[++i]
    if (a === '--base-url') args.baseUrl = take()
    else if (a === '--api-key') args.apiKey = take()
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--send') args.send = true
    else if (a === '--rpc') args.rpc = take()
    else if (a === '--report') args.report = take()
    else if (a === '--approval') args.approval = take()
    else if (a === '--resume') args.resume = take()
    else if (a === '--image') args.image = take()
    else if (a === '--no-launch-build') args.launchBuild = false
    else if (a === '--help' || a === '-h') args.help = true
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`)
    else positional.push(a)
  }
  if (!args.baseUrl && positional.length > 0) args.baseUrl = positional[0]
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    'Usage: node scripts/acceptance.mjs [--dry-run|--send] [--base-url URL] ' +
      '[--rpc URL] [--report PATH] [--approval PATH] [--resume REPORT] [--image PATH] [--no-launch-build]',
  )
  process.exit(0)
}

const BASE_URL = (
  args.baseUrl ||
  process.env.ACCEPTANCE_BASE_URL ||
  'https://skill.seekuplift.com'
).replace(/\/+$/, '')
// TB-S-3: every /api/* endpoint requires X-Api-Key: <id>:<secret> when the
// service has AGENT_API_KEYS configured (production does).
const API_KEY = args.apiKey || process.env.AGENT_API_KEY || null
const RPC_URL =
  args.rpc ||
  process.env.ACCEPTANCE_RPC ||
  process.env.SOLANA_RPC_URL ||
  'https://api.mainnet-beta.solana.com'
const APPROVAL_FILE =
  args.approval ||
  process.env.ACCEPTANCE_APPROVAL_FILE ||
  path.resolve('acceptance-approval.json')
const REPORT_FILE =
  args.report ||
  process.env.ACCEPTANCE_REPORT ||
  (args.resume ? path.resolve(args.resume) : null) ||
  path.resolve(`acceptance-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
const IMAGE_FILE = args.image || process.env.ACCEPTANCE_IMAGE || null

if (args.send && args.dryRun) {
  console.error('FATAL: --send and --dry-run are mutually exclusive')
  process.exit(2)
}
if (args.send && !args.launchBuild) {
  console.error('FATAL: --send requires the launch build (--no-launch-build is a dry-run option)')
  process.exit(2)
}
const SEND = args.send === true
const RESUME_POOL = process.env.ACCEPTANCE_POOL || null
if ((args.resume || RESUME_POOL) && !SEND) {
  console.error('FATAL: --resume / ACCEPTANCE_POOL continue a real run and require --send')
  process.exit(2)
}

// ─── Small utilities ──────────────────────────────────────────────────────────
const now = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isLoopback(url) {
  try {
    const host = new URL(url).hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

async function apiFetch(route, { method = 'GET', body, timeoutMs = 120_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON body — keep the raw text */
    }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

/** scheme+host only — RPC URLs carry API keys in the path or query. */
function redactUrl(u) {
  try {
    const url = new URL(u)
    return `${url.protocol}//${url.host}`
  } catch {
    return '[invalid-url]'
  }
}

/** Message-only, secret-scrubbed text for logs and report.error. */
function sanitize(text) {
  let s = String(text)
  if (RPC_URL) s = s.split(RPC_URL).join(redactUrl(RPC_URL))
  s = s.replace(/https?:\/\/[^\s"'`)]+/g, (m) => redactUrl(m))
  s = s.replace(/(api[-_]?key|token|secret)=[^&\s"']+/gi, '$1=REDACTED')
  return s.slice(0, 2000)
}

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex')

function fail(msg) {
  const err = new Error(msg)
  err.isStepFailure = true
  return err
}

/**
 * Display-units → raw atoms using the quote mint's decimals and the
 * Token-2022 ScaledUiAmount multiplier in effect (SKILL.md: display ×
 * 10^decimals ÷ multiplier). Exact BigInt math, no floats on the money path.
 */
function displayToAtoms(display, decimals, multiplier) {
  const [iPart, fPart = ''] = String(display).trim().split('.')
  if (!/^\d+$/.test(iPart || '0') || (fPart && !/^\d+$/.test(fPart))) {
    throw fail(`cannot parse display amount "${display}"`)
  }
  const dec = BigInt(decimals)
  const fracPadded = (fPart + '0'.repeat(decimals)).slice(0, decimals) || '0'
  const numerator = BigInt(iPart || '0') * 10n ** dec + BigInt(fracPadded || '0')
  const mult = String(multiplier ?? '1').trim()
  const [mi, mf = ''] = mult.split('.')
  if (!/^\d+$/.test(mi || '0') || (mf && !/^\d+$/.test(mf))) {
    throw fail(`cannot parse scaledUiAmount multiplier "${mult}"`)
  }
  const mDen = 10n ** BigInt(mf.length)
  const mNum = BigInt(mi || '0') * mDen + BigInt(mf || '0')
  if (mNum <= 0n) throw fail(`non-positive scaledUiAmount multiplier "${mult}"`)
  return (numerator * mDen) / mNum
}

// ─── Minimal PNG encoder (no deps) — the default acceptance image ─────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 256×256 RGB PNG: dark indigo field, teal ring, light diamond — the
 *  acceptance coin's generated mark (replace with ACCEPTANCE_IMAGE). */
function generatedImagePng() {
  const size = 256
  const raw = Buffer.alloc((size * 3 + 1) * size)
  const cx = 128, cy = 128
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy
      const r = Math.sqrt(dx * dx + dy * dy)
      const manhattan = Math.abs(dx) + Math.abs(dy)
      let rr = 18 + ((x + y) % 64) / 8, gg = 16 + (y % 48) / 4, bb = 46 + (x % 64) / 4
      if (r > 78 && r < 96) { rr = 45; gg = 200; bb = 170 }            // ring
      if (manhattan < 46) { rr = 235; gg = 240; bb = 255 }             // diamond
      if (manhattan < 34) { rr = 45; gg = 200; bb = 170 }              // diamond core
      const off = row + 1 + x * 3
      raw[off] = Math.min(255, Math.round(rr))
      raw[off + 1] = Math.min(255, Math.round(gg))
      raw[off + 2] = Math.min(255, Math.round(bb))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function loadImage() {
  if (IMAGE_FILE) {
    const bytes = fs.readFileSync(IMAGE_FILE)
    return { base64: bytes.toString('base64'), source: IMAGE_FILE }
  }
  return { base64: generatedImagePng().toString('base64'), source: 'generated PNG' }
}

// ─── Keypair ──────────────────────────────────────────────────────────────────
function loadPayer() {
  const keypairPath = process.env.ACCEPTANCE_KEYPAIR
  if (!keypairPath) {
    if (SEND) {
      throw fail('--send requires ACCEPTANCE_KEYPAIR pointing at the payer/owner keypair file')
    }
    const simPayer = process.env.ACCEPTANCE_SIM_PAYER
    if (simPayer) {
      // Dry-run never signs, so a public key alone is enough.
      const publicKey = new PublicKey(simPayer)
      console.log(`[setup] dry-run simulates as funded ACCEPTANCE_SIM_PAYER ${publicKey.toBase58()}`)
      return { keypair: { publicKey }, source: 'sim payer (dry-run)' }
    }
    const ephemeral = Keypair.generate()
    console.log(`[setup] no ACCEPTANCE_KEYPAIR — dry-run uses ephemeral payer ${ephemeral.publicKey.toBase58()}`)
    return { keypair: ephemeral, source: 'ephemeral (dry-run)' }
  }
  // Never echo file content or parser messages (they can quote secret bytes).
  let keypair
  try {
    const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    if (!Array.isArray(raw)) throw new Error('not an array')
    keypair = Keypair.fromSecretKey(Uint8Array.from(raw))
  } catch {
    throw fail(`ACCEPTANCE_KEYPAIR file ${keypairPath} is unreadable or not a valid Solana keypair JSON byte array`)
  }
  console.log(`[setup] payer/owner ${keypair.publicKey.toBase58()} from ${keypairPath}`)
  return { keypair, source: keypairPath }
}

// ─── Approval gate (--send only) ──────────────────────────────────────────────
function checkApproval(plan) {
  if (!fs.existsSync(APPROVAL_FILE)) {
    throw fail(
      `--send refused: no approval file at ${APPROVAL_FILE}. Run --dry-run, review the printed ` +
        'plan, and once the owner approves it write ' +
        `{ "approved": true, "planHash": "${plan.planHash}", "approvedBy": "<owner>", "approvedAt": "<iso>" }`,
    )
  }
  let approval
  try {
    approval = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8'))
  } catch (err) {
    throw fail(`--send refused: approval file ${APPROVAL_FILE} is not valid JSON`)
  }
  if (approval?.approved !== true) {
    throw fail(`--send refused: approval file ${APPROVAL_FILE} does not contain "approved": true`)
  }
  if (typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim()) {
    throw fail('--send refused: approval file needs a non-empty "approvedBy"')
  }
  if (typeof approval.approvedAt !== 'string' || Number.isNaN(Date.parse(approval.approvedAt))) {
    throw fail('--send refused: approval file needs an ISO "approvedAt" timestamp')
  }
  if (approval.planHash !== plan.planHash) {
    throw fail(
      `--send refused: approval planHash ${approval.planHash ?? '(missing)'} != this run's planHash ` +
        `${plan.planHash}. Something in the plan changed (or was never approved); re-run --dry-run, ` +
        'review the plan and re-approve.',
    )
  }
  if (BASE_URL !== PROD_BASE_URL && process.env.ACCEPTANCE_ALLOW_LOCAL_SEND !== 'yes') {
    throw fail(
      `--send refused: base URL ${BASE_URL} is not ${PROD_BASE_URL}. Real sends belong against the ` +
        'deployed service (ticket 08); set ACCEPTANCE_ALLOW_LOCAL_SEND=yes only if you are certain.',
    )
  }
  console.log(
    `[gate] owner approval on file for plan ${plan.planHash} ` +
      `by ${approval.approvedBy} at ${approval.approvedAt}`,
  )
  return approval
}

// ─── Run state / reporting ────────────────────────────────────────────────────
const connection = new Connection(RPC_URL, 'confirmed')

function loadPriorReport(file) {
  try {
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!prior || typeof prior !== 'object') throw new Error('not an object')
    return prior
  } catch (err) {
    console.error(`FATAL: --resume: cannot read report ${file}: ${sanitize(err instanceof Error ? err.message : err)}`)
    process.exit(2)
  }
}

const priorReport = args.resume ? loadPriorReport(args.resume) : null
const report = priorReport
  ? {
      ...priorReport,
      mode: 'send',
      baseUrl: BASE_URL,
      rpcUrl: redactUrl(RPC_URL),
      resumedAt: new Date().toISOString(),
      steps: Array.isArray(priorReport.steps) ? priorReport.steps : [],
      signatures: priorReport.signatures ?? {},
      result: 'running',
      error: undefined,
      finishedAt: undefined,
    }
  : {
      ticket: '09-real-coin-acceptance',
      mode: SEND ? 'send' : 'dry-run',
      baseUrl: BASE_URL,
      rpcUrl: redactUrl(RPC_URL),
      startedAt: new Date().toISOString(),
      coin: { ...COIN, buyAmountDisplay: BUY_AMOUNT_DISPLAY, sellBps: SELL_BPS, slippageBps: SLIPPAGE_BPS },
      steps: [],
      signatures: {},
      result: 'running',
    }

/** Persist the report. Called after every step and at each on-chain milestone
 *  so a crash never loses the mint/pool/signatures. */
function writeReport({ final = false } = {}) {
  report.updatedAt = new Date().toISOString()
  if (final) report.finishedAt = report.updatedAt
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n')
}

/** What landed on-chain and how to continue — printed on any failure. */
function printRecovery() {
  if (!SEND) return
  const landed = report.launched ?? report.launchAttempt
  console.error('\n--- RECOVERY ---')
  if (landed) {
    console.error(`Launch ${report.launched ? 'CONFIRMED' : 'SENT (confirmation unknown)'}: mint ${landed.mintAddress}, pool ${landed.poolAddress}` +
      (landed.signature ? `, signature ${landed.signature}` : ''))
    console.error('DO NOT launch again. Verify the signature/pool on an explorer, then continue with:')
    console.error(`  node scripts/acceptance.mjs --send --resume ${REPORT_FILE}`)
  } else {
    console.error('No launch transaction was sent; nothing landed. Fix the cause above and re-run the same --send command.')
  }
  const others = Object.entries(report.signatures).filter(([k]) => k !== 'launch')
  if (others.length) {
    console.error('Other sent signatures (check each before resuming): ' + others.map(([k, v]) => `${k}=${v}`).join(' '))
  }
  console.error(`Report: ${REPORT_FILE}`)
}

let stepIndex = report.steps.length
const ctx = {
  capabilities: [],
  entry: null, // chosen catalog entry
  launch: null, // launch response
  pool: null, // pool used for trades (dry-run: an existing curve pool)
  launchConfirmedAt: null,
  launchSlot: null,
  launchBlockTime: null,
  plan: null,
  image: null,
  launchProbe: null,
  resume: null,
  buyQuote: null,
  boughtBaseAtoms: 0n,
  sellQuote: null,
}

async function step(name, capability, fn) {
  stepIndex += 1
  const label = `step ${stepIndex}: ${name}${capability ? ` [capability: ${capability}]` : ''}`
  console.log(`\n=== ${label} ===`)
  const started = now()
  try {
    const detail = await fn()
    report.steps.push({ step: stepIndex, name, capability, status: 'pass', detail, ms: now() - started })
    writeReport()
    console.log(`--- PASS ${name} (${now() - started} ms)`)
  } catch (err) {
    const detail = sanitize(err instanceof Error ? err.message : String(err))
    report.steps.push({ step: stepIndex, name, capability, status: 'fail', error: detail, ms: now() - started })
    report.result = 'fail'
    writeReport({ final: true })
    console.error(`--- FAIL ${name}: ${detail}`)
    console.error(`Report written to ${REPORT_FILE}`)
    printRecovery()
    process.exit(1)
  }
}

function skipSend(what) {
  console.log(`[SKIP-SEND] ${what} — dry-run does not sign, send or confirm`)
}

async function simulate(tx, label, { payerHoldsInput = true } = {}) {
  // Read-only mainnet simulation (sigVerify off). A funded payer (real
  // keypair or ACCEPTANCE_SIM_PAYER) must simulate clean; an ephemeral one
  // fails at fee-payer lookup before any instruction runs, which proves
  // nothing — reported as inconclusive, never as a clean build.
  const funded = payerHoldsInput && !ctx.payer?.source.startsWith('ephemeral')
  try {
    const vtx = tx instanceof VersionedTransaction ? tx : new VersionedTransaction(tx.compileMessage())
    const result = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true })
    const err = result.value.err
    const errJson = JSON.stringify(err)
    console.log(`[simulate] ${label}: unitsConsumed=${result.value.unitsConsumed} err=${errJson}`)
    if (err && funded) {
      throw fail(`${label} simulation failed for a funded payer: ${errJson}`)
    }
    if (err) {
      console.log(
        `[simulate] ${label}: INCONCLUSIVE — ` +
          (payerHoldsInput
            ? 'ephemeral unfunded payer; set ACCEPTANCE_SIM_PAYER or ACCEPTANCE_KEYPAIR'
            : 'the dry-run payer holds none of the coin it would sell'),
      )
    }
    return { unitsConsumed: result.value.unitsConsumed ?? null, err: err ?? null }
  } catch (err) {
    if (err.isStepFailure) throw err
    console.log(`[simulate] ${label}: RPC simulation call failed (non-fatal): ${sanitize(err)}`)
    return { error: sanitize(err) }
  }
}

async function sendAndConfirm(tx, keypair, label) {
  // The launch tx arrives mint-partial-signed (payer slot empty); trade txs
  // arrive unsigned. partialSign fills exactly our slot in both cases.
  tx.partialSign(keypair)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  console.log(`[send] ${label} signature: ${sig}`)
  report.signatures[label] = sig
  writeReport() // signature on disk before we wait on confirmation
  // Poll signature status — the tx's blockhash was fetched server-side at
  // build time, so a fresh getLatestBlockhash pair would not describe it.
  const deadline = now() + 180_000
  for (;;) {
    const res = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    const status = res.value[0]
    if (status?.err) {
      throw fail(`${label} confirmed with error: ${JSON.stringify(status.err)}`)
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      ctx.lastConfirmSlot = status.slot ?? null
      return sig
    }
    if (now() > deadline) throw fail(`${label} (${sig}) not confirmed within 180s`)
    await sleep(2_000)
  }
}

async function tokenAtoms(owner, mint) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
  })
  let sum = 0n
  for (const { account } of res.value) {
    sum += BigInt(account.data.parsed.info.tokenAmount.amount)
  }
  return sum
}

async function quoteAtoms(owner, poolInfo) {
  if (poolInfo.isQuoteSol) return BigInt(await connection.getBalance(owner, 'confirmed'))
  return tokenAtoms(owner, poolInfo.quoteMint)
}

/** The ScaledUiAmount multiplier in effect now (new at/after its timestamp). */
function effectiveMultiplier(scaled) {
  if (!scaled) return '1'
  const ts = scaled.newMultiplierEffectiveTimestamp
  const useNew = Number.isFinite(ts) && Math.floor(Date.now() / 1000) >= ts
  return (useNew ? scaled.newMultiplier : scaled.multiplier) ?? '1'
}

function assertMovedAsQuoted(delta, quote, side) {
  // "Moved as quoted within slippage" is a FLOOR check — minimumAmountOut is
  // what the tx guaranteed. A fill better than quoted is a pass, not a miss
  // (any intervening curve move between quote and send can improve it).
  const min = BigInt(quote.minimumAmountOut)
  const expected = BigInt(quote.amountOut)
  if (delta < min) {
    throw fail(`${side} moved ${delta} atoms — below minimumAmountOut ${min}`)
  }
  if (delta > expected) {
    console.log(`[check] ${side} moved ${delta} atoms — better than the quoted ${expected} (min ${min})`)
  } else {
    console.log(`[check] ${side} moved ${delta} atoms (min ${min}, quoted ${expected}) — within slippage`)
  }
  return { delta: delta.toString(), minimumAmountOut: min.toString(), amountOut: expected.toString() }
}

// ─── The steps ────────────────────────────────────────────────────────────────
const KNOWN_CAPABILITIES = ['list_configs', 'launch_token', 'trade_quote', 'trade_tx', 'list_pools', 'claim_fees']

async function stepDocs() {
  // The run drives the CURRENT (v2) contract — the unversioned paths serve
  // the frozen v1 document until its sunset.
  const md = await apiFetch('/v2/skill.md')
  if (md.status !== 200) throw fail(`/v2/skill.md returned ${md.status}`)
  if (!md.text.includes('list_configs')) throw fail('/v2/skill.md does not look like the v2 skill document')
  const js = await apiFetch('/v2/skill.json')
  if (js.status !== 200 || !js.json) throw fail(`/v2/skill.json returned ${js.status} or non-JSON`)
  const jsonCaps = (js.json.capabilities ?? []).map((c) => c?.id).filter(Boolean)
  // SKILL.md lists capabilities as "### N. `id` — METHOD /path" headings.
  const mdCaps = [...md.text.matchAll(/^###\s+\d+\.\s+`([a-z_]+)`/gm)].map((m) => m[1])
  for (const [source, caps] of [['skill.json', jsonCaps], ['SKILL.md', mdCaps]]) {
    for (const required of KNOWN_CAPABILITIES) {
      if (!caps.includes(required)) throw fail(`${source} is missing capability "${required}"`)
    }
    for (const cap of caps) {
      if (!KNOWN_CAPABILITIES.includes(cap)) {
        // One-to-one contract: a new capability needs a new acceptance step.
        throw fail(`${source} advertises capability "${cap}" with no acceptance step — add one`)
      }
    }
  }
  const sortedJson = [...jsonCaps].sort().join(',')
  const sortedMd = [...mdCaps].sort().join(',')
  if (sortedJson !== sortedMd) {
    throw fail(`skill.json capabilities [${sortedJson}] differ from SKILL.md [${sortedMd}]`)
  }
  ctx.capabilities = jsonCaps
  return { skillMdBytes: md.text.length, capabilities: jsonCaps, skillMdCapabilities: mdCaps, version: js.json.version ?? null }
}

async function stepConfigs() {
  const res = await apiFetch('/api/configs')
  if (res.status !== 200) throw fail(`/api/configs returned ${res.status}: ${res.text.slice(0, 300)}`)
  const configs = res.json?.configs
  if (!Array.isArray(configs) || configs.length === 0) throw fail('/api/configs returned no configs')
  const entry = configs.find((c) => Array.isArray(c.defaultFor) && c.defaultFor.includes('meme'))
  if (!entry) throw fail('no config is marked defaultFor:["meme"] — the memecoin default is missing')
  const share = entry.fees?.creatorSharePct
  if (!(typeof share === 'number' && share > 0)) {
    throw fail(`memecoin default ${entry.configKey} has creatorSharePct ${share} — expected a creator-fee config (> 0)`)
  }
  if (entry.fees?.allFeesToCause === true) {
    throw fail(`memecoin default ${entry.configKey} is allFeesToCause — must be a creator-fee config`)
  }
  if (entry.decodeError) throw fail(`memecoin default ${entry.configKey} has decodeError: ${entry.decodeError}`)
  if (!entry.categories?.includes('meme')) throw fail(`memecoin default ${entry.configKey} does not serve category "meme"`)
  if (!entry.quote?.mint || entry.quote.decimals == null) {
    throw fail(`memecoin default ${entry.configKey} has no resolvable quote mint/decimals`)
  }
  ctx.entry = entry
  const memeGeo = entry.geo?.byCategory?.meme ?? { allowed: entry.geo?.allowed, reason: entry.geo?.reason }
  if (memeGeo?.allowed === false) {
    console.log(`[configs] WARNING: geo verdict blocks meme launches for this caller: ${memeGeo.reason} (region ${entry.geo?.region}) — the launch step will be refused`)
  }
  return {
    configKey: entry.configKey,
    optionId: entry.optionId,
    quote: entry.quote,
    feeLabel: entry.fees?.label,
    creatorSharePct: share,
    curve: entry.fees?.curve,
    supportsCause: entry.supportsCause,
    supportsFirstBuy: entry.supportsFirstBuy,
    poolCreationFeeLamports: entry.poolCreationFeeLamports,
    geo: memeGeo,
  }
}

function launchBody(plan, payerPublicKey) {
  return {
    configKey: plan.configKey,
    category: plan.category,
    name: plan.name,
    symbol: plan.symbol,
    description: plan.description,
    image: ctx.image.base64,
    payerPublicKey,
    ...(plan.firstBuyAmount !== '0' ? { firstBuyAmount: plan.firstBuyAmount } : {}),
    ...(plan.donation.mode === 'cause' ? { donation: { mode: 'cause', cause: plan.donation.cause } } : {}),
  }
}

/**
 * Resolve the donation deterministically BEFORE approval: pinned via
 * ACCEPTANCE_DONATION_CAUSE, else probe /api/launch without a donation (the
 * service refuses with causesOffered before any upload when causes are
 * offered) and take causesOffered[0]. A 200 means no cause is required; that
 * build is kept and reused by the launch step while still fresh.
 */
async function resolveDonation(entry, plan0, payerKey) {
  if (!entry.supportsCause) return { mode: 'none' }
  const pinned = process.env.ACCEPTANCE_DONATION_CAUSE
  if (pinned) return { mode: 'cause', cause: pinned }
  if (!args.launchBuild) return { mode: 'unresolved' }
  const res = await apiFetch('/api/launch', {
    method: 'POST',
    body: launchBody({ ...plan0, donation: { mode: 'none' } }, payerKey),
  })
  if (res.status === 400 && res.json?.error === 'donation_required') {
    const offered = res.json.causesOffered ?? []
    if (offered.length === 0) throw fail('donation_required but causesOffered is empty')
    return { mode: 'cause', cause: offered[0] }
  }
  if (res.status === 200) {
    ctx.launchProbe = { res, at: now() }
    return { mode: 'none' }
  }
  throw fail(`donation probe: /api/launch returned ${res.status}: ${res.text.slice(0, 300)}`)
}

async function stepPlan() {
  const entry = ctx.entry
  ctx.image = loadImage()
  report.coin.image = ctx.image.source
  const payerKey = ctx.payer.keypair.publicKey.toBase58()
  const firstBuyAmount = entry.supportsFirstBuy
    ? String(process.env.ACCEPTANCE_FIRST_BUY ?? entry.quote.firstBuyDefault ?? '0')
    : '0'
  // Key order is fixed: the hash is over JSON.stringify of exactly this object.
  const core = {
    baseUrl: BASE_URL,
    configKey: entry.configKey,
    category: COIN.category,
    name: COIN.name,
    symbol: COIN.symbol,
    description: COIN.description,
    imageSha256: sha256Hex(Buffer.from(ctx.image.base64, 'base64')),
    quoteMint: entry.quote.mint,
    quoteDecimals: entry.quote.decimals,
    firstBuyAmount,
    buyAmount: String(BUY_AMOUNT_DISPLAY),
    sellRule: `${SELL_BPS} bps of purchased base balance`,
    slippageBps: SLIPPAGE_BPS,
    donation: { mode: 'none' },
    payer: payerKey,
  }
  core.donation = await resolveDonation(entry, core, payerKey)
  const planHash = sha256Hex(JSON.stringify(core))
  ctx.plan = { ...core, planHash }
  report.plan = ctx.plan
  report.planImageSource = ctx.image.source
  console.log('\n[plan] full run plan (approve by writing this planHash into the approval file):')
  console.log(JSON.stringify(ctx.plan, null, 2))
  console.log(`[plan] PLAN HASH: ${planHash}`)
  if (ctx.payer.source.startsWith('ephemeral')) {
    console.log('[plan] NOTE: payer is ephemeral — set ACCEPTANCE_KEYPAIR to get an approvable hash')
  }
  if (core.donation.mode === 'unresolved') {
    console.log('[plan] NOTE: donation cause not resolved (--no-launch-build); this hash is not approvable')
    if (SEND) throw fail('donation cause unresolved — cannot send')
  }
  return { planHash, donation: core.donation, imageSource: ctx.image.source }
}

/** After approval: resume bookkeeping and the never-launch-twice guard. */
function prepareResumeAndGuard() {
  const plan = ctx.plan
  if (priorReport || RESUME_POOL) {
    if (priorReport) {
      if (priorReport.plan?.planHash !== plan.planHash) {
        throw fail(
          `--resume: report planHash ${priorReport.plan?.planHash ?? '(none)'} != this run's ${plan.planHash} — ` +
            'the plan changed; resume only with an identical, approved plan',
        )
      }
      const landed = priorReport.launched ?? priorReport.launchAttempt
      if (!landed?.mintAddress || !landed?.poolAddress) {
        throw fail('--resume: the report records no launched mint/pool — nothing to resume; run without --resume')
      }
      ctx.resume = { ...landed, signature: landed.signature ?? priorReport.signatures?.launch ?? null }
    } else {
      ctx.resume = { poolAddress: RESUME_POOL, mintAddress: null, signature: null }
    }
    return
  }
  // Fresh launch: refuse if any prior report for this planHash launched a coin.
  const dirs = new Set([process.cwd(), path.dirname(REPORT_FILE)])
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!/^acceptance-report.*\.json$/.test(f)) continue
      const full = path.join(dir, f)
      if (path.resolve(full) === path.resolve(REPORT_FILE)) continue
      let r
      try { r = JSON.parse(fs.readFileSync(full, 'utf8')) } catch { continue }
      const landed = r?.launched ?? r?.launchAttempt
      if (r?.plan?.planHash === plan.planHash && landed?.mintAddress) {
        throw fail(
          `refusing to launch a second coin: ${full} already records mint ${landed.mintAddress} ` +
            `(pool ${landed.poolAddress}) for this planHash. Verify it on an explorer, then continue with ` +
            `--send --resume ${full} (or delete that report only if the launch provably did not land).`,
        )
      }
    }
  }
}

/** Payer SOL + quote-token balances vs the plan's needs (+ fee margin). */
async function stepPreflight() {
  const plan = ctx.plan
  const entry = ctx.entry
  const owner = ctx.payer.keypair.publicKey
  const multiplier = entry.quote?.scaledUiAmountMultiplier ?? '1'
  const resuming = ctx.resume != null
  const dec = plan.quoteDecimals
  const firstBuyAtoms = resuming ? 0n : displayToAtoms(plan.firstBuyAmount, dec, multiplier)
  const buyAtoms = displayToAtoms(plan.buyAmount, dec, multiplier)
  const quoteSpend = ((firstBuyAtoms + buyAtoms) * (10_000n + QUOTE_MARGIN_BPS)) / 10_000n
  const isSol = plan.quoteMint === WSOL_MINT
  let needSol = resuming
    ? SOL_MARGIN_TRADES_LAMPORTS
    : BigInt(entry.poolCreationFeeLamports ?? 0) + SOL_MARGIN_LAUNCH_LAMPORTS
  if (isSol) needSol += quoteSpend
  const haveSol = BigInt(await connection.getBalance(owner, 'confirmed'))
  const haveQuote = isSol ? haveSol : await tokenAtoms(owner, plan.quoteMint)
  const detail = {
    payer: owner.toBase58(),
    solLamports: { have: haveSol.toString(), need: needSol.toString() },
    quoteAtoms: isSol ? 'counted in SOL' : { have: haveQuote.toString(), need: quoteSpend.toString(), mint: plan.quoteMint },
  }
  console.log(`[preflight] ${JSON.stringify(detail)}`)
  const short = []
  if (haveSol < needSol) short.push(`SOL ${haveSol} < ${needSol} lamports`)
  if (!isSol && haveQuote < quoteSpend) short.push(`quote token ${haveQuote} < ${quoteSpend} atoms (${plan.quoteMint})`)
  if (short.length) {
    if (SEND) throw fail(`payer ${owner.toBase58()} is underfunded — ${short.join('; ')}. Nothing was sent.`)
    console.log(`[preflight] dry-run: would refuse --send — ${short.join('; ')}`)
    detail.wouldRefuse = short
  }
  return detail
}

async function stepLaunch(payer) {
  if (ctx.resume) return resumeLaunch()
  if (!args.launchBuild) {
    skipSend('launch build (--no-launch-build): nothing was uploaded or built')
    return { skipped: 'no-launch-build' }
  }
  const plan = ctx.plan
  const payerKey = payer.keypair.publicKey.toBase58()
  const body = launchBody(plan, payerKey)

  // Reuse the donation probe's build when it is fresh (blockhash still valid);
  // otherwise post the plan's body, donation included. The donation is NEVER
  // re-picked here: if the offered causes changed, the plan must be re-approved.
  let res
  if (ctx.launchProbe && now() - ctx.launchProbe.at < 45_000) {
    res = ctx.launchProbe.res
  } else {
    res = await apiFetch('/api/launch', { method: 'POST', body })
  }
  if (res.status === 400 && res.json?.error === 'donation_required') {
    throw fail('donation became required since the plan was resolved — re-run --dry-run and re-approve the new plan')
  }
  if (res.status !== 200) {
    throw fail(`/api/launch returned ${res.status}: ${res.text.slice(0, 500)}`)
  }
  const launch = res.json
  for (const field of ['transaction', 'mintAddress', 'poolAddress', 'metadataUrl', 'configKey']) {
    if (!launch[field]) throw fail(`/api/launch response missing ${field}`)
  }
  if (launch.configKey !== plan.configKey) {
    throw fail(`/api/launch built config ${launch.configKey}, plan says ${plan.configKey}`)
  }
  const tx = Transaction.from(Buffer.from(launch.transaction, 'base64'))
  const mintSig = tx.signatures.find((s) => s.publicKey.toBase58() === launch.mintAddress)
  const payerSig = tx.signatures.find((s) => s.publicKey.toBase58() === payerKey)
  if (!mintSig?.signature) throw fail('launch tx is missing the mint partial signature')
  if (payerSig?.signature) throw fail('launch tx payer slot is unexpectedly signed')
  if (!tx.feePayer || tx.feePayer.toBase58() !== payerKey) {
    throw fail(`launch tx feePayer is ${tx.feePayer?.toBase58() ?? 'unset'} — expected ${payerKey}`)
  }
  const sim = await simulate(tx, 'launch')

  const donation = plan.donation
  ctx.launch = { ...launch, donation, firstBuyAmount: plan.firstBuyAmount }
  if (!SEND) {
    skipSend(`launch sign+send+confirm for mint ${launch.mintAddress} / pool ${launch.poolAddress}`)
    return {
      mode: 'build-only',
      note:
        'validates the full launch path short of the payer signature: image+metadata ' +
        'uploaded through the backend (2 upload-budget slots spent), the mint-partial-signed ' +
        'transaction was built and parses; the derived pool does not exist on-chain until the tx sends.',
      mintAddress: launch.mintAddress,
      poolAddress: launch.poolAddress,
      metadataUrl: launch.metadataUrl,
      firstBuyAmount: plan.firstBuyAmount,
      donation,
      simulation: sim,
    }
  }
  // Persist mint/pool BEFORE sending: a crash after send must not lose them.
  report.launchAttempt = { mintAddress: launch.mintAddress, poolAddress: launch.poolAddress, builtAt: new Date().toISOString() }
  writeReport()
  const sig = await sendAndConfirm(tx, payer.keypair, 'launch')
  ctx.launchConfirmedAt = now()
  ctx.launchSlot = ctx.lastConfirmSlot ?? null
  ctx.launchBlockTime = await getBlockTimeSafe(ctx.launchSlot)
  report.launched = {
    mintAddress: launch.mintAddress,
    poolAddress: launch.poolAddress,
    signature: sig,
    slot: ctx.launchSlot,
    blockTime: ctx.launchBlockTime,
    confirmedAt: new Date().toISOString(),
  }
  writeReport() // mint, pool, launch signature on disk immediately
  return {
    mintAddress: launch.mintAddress,
    poolAddress: launch.poolAddress,
    signature: sig,
    firstBuyAmount: plan.firstBuyAmount,
    donation,
  }
}

async function getBlockTimeSafe(slot) {
  if (slot == null) return null
  try {
    return await connection.getBlockTime(slot)
  } catch {
    return null
  }
}

/** --resume / ACCEPTANCE_POOL: no launch; verify the recorded pool exists. */
async function resumeLaunch() {
  const r = ctx.resume
  const info = await connection.getAccountInfo(new PublicKey(r.poolAddress), 'confirmed')
  if (!info) {
    throw fail(
      `resume: pool ${r.poolAddress} does not exist on-chain (launch ${r.signature ?? 'signature unknown'} did not land or is not confirmed yet). ` +
        'Check the signature on an explorer; do not relaunch while it may still land.',
    )
  }
  let mint = r.mintAddress
  if (!mint) {
    const probe = await apiFetch('/api/trade/quote', {
      method: 'POST',
      body: { poolAddress: r.poolAddress, side: 'buy', amountIn: '1' },
    })
    if (probe.status !== 200) throw fail(`resume: cannot read pool ${r.poolAddress} via the service (${probe.status})`)
    mint = probe.json.poolInfo.baseMint
  }
  ctx.launch = { mintAddress: mint, poolAddress: r.poolAddress }
  if (r.signature) {
    const st = (await connection.getSignatureStatuses([r.signature], { searchTransactionHistory: true })).value[0]
    ctx.launchSlot = st?.slot ?? r.slot ?? null
    ctx.launchBlockTime = r.blockTime ?? (await getBlockTimeSafe(ctx.launchSlot))
  }
  ctx.launchConfirmedAt = r.confirmedAt ? Date.parse(r.confirmedAt) : null
  if (!report.launched) {
    report.launched = { mintAddress: mint, poolAddress: r.poolAddress, signature: r.signature, slot: ctx.launchSlot, blockTime: ctx.launchBlockTime, confirmedAt: new Date().toISOString(), recoveredByResume: true }
    writeReport()
  }
  console.log(`[resume] continuing from pool ${r.poolAddress} / mint ${mint} — launch skipped`)
  return { resumed: true, mintAddress: mint, poolAddress: r.poolAddress, signature: r.signature }
}

async function findTradeablePool(entry, limit = 10) {
  // Dry-run trade target: an existing curve pool, preferring one on the
  // launch config. Returns the candidate list; the trade step quotes each
  // until one answers (a 404/409 means that pool left the curve).
  const res = await apiFetch(`/api/pools?category=meme&sortBy=createdAt&limit=${limit}`)
  if (res.status !== 200) throw fail(`pool list for dry-run trade target returned ${res.status}`)
  const pools = res.json?.pools ?? []
  const sorted = [...pools].sort((a, b) => {
    const aCfg = a.configKey === entry.configKey ? 0 : 1
    const bCfg = b.configKey === entry.configKey ? 0 : 1
    const aGrad = a.graduated ? 1 : 0
    const bGrad = b.graduated ? 1 : 0
    return aCfg - bCfg || aGrad - bGrad
  })
  return sorted
}

async function stepPools() {
  if (SEND) {
    // Find the just-launched coin via BOTH search and list, the way an agent
    // following SKILL.md would (a pool's `id` is the poolAddress trades take).
    // Search by mint, symbol AND name (each must return the new pool), then list.
    const deadline = now() + 180_000
    const queries = {
      mint: ctx.launch.mintAddress,
      symbol: ctx.plan.symbol,
      name: ctx.plan.name,
    }
    const foundBy = {}
    while (now() < deadline) {
      for (const [kind, q] of Object.entries(queries)) {
        if (foundBy[kind]) continue
        const res = await apiFetch(`/api/pools?search=${encodeURIComponent(q)}&limit=50`)
        if (res.status === 200 && (res.json?.pools ?? []).some((p) => p.id === ctx.launch.poolAddress)) {
          foundBy[kind] = ctx.launch.poolAddress
        }
      }
      if (Object.keys(queries).every((k) => foundBy[k])) break
      await sleep(10_000)
    }
    const missing = Object.keys(queries).filter((k) => !foundBy[k])
    if (missing.length) {
      throw fail(`launched pool ${ctx.launch.poolAddress} never appeared in /api/pools search by: ${missing.join(', ')}`)
    }
    const list = await apiFetch('/api/pools?category=meme&lifecycle=new&sortBy=createdAt&limit=50')
    if (list.status !== 200) throw fail(`/api/pools list returned ${list.status}`)
    const listed = (list.json?.pools ?? []).find((p) => p.id === ctx.launch.poolAddress)
    if (!listed) throw fail(`launched pool ${ctx.launch.poolAddress} missing from the meme/new list`)
    ctx.pool = { poolAddress: ctx.launch.poolAddress, baseMint: ctx.launch.mintAddress, listing: listed }
    return { foundBySearch: foundBy, foundByList: listed.id }
  }

  // Dry-run: no coin exists — validate both endpoint shapes and pick a live
  // curve pool for the trade build steps.
  const symbol = COIN.symbol
  const search = await apiFetch(`/api/pools?search=${encodeURIComponent(symbol)}&limit=5`)
  if (search.status !== 200) throw fail(`/api/pools?search= returned ${search.status}`)
  if (!Array.isArray(search.json?.pools) || search.json.nextCursor !== null) {
    throw fail('/api/pools search response shape is wrong (expected pools[] and nextCursor null)')
  }
  const list = await apiFetch('/api/pools?category=meme&sortBy=createdAt&limit=10')
  if (list.status !== 200 || !Array.isArray(list.json?.pools)) {
    throw fail(`/api/pools list returned ${list.status} or wrong shape`)
  }
  ctx.poolCandidates = await findTradeablePool(ctx.entry)
  return {
    searchHits: search.json.pools.length,
    listedPools: list.json.pools.length,
    tradeCandidates: ctx.poolCandidates.slice(0, 5).map((p) => `${p.symbol}(${p.id})`),
  }
}

/**
 * Has the launch config's fee curve reached its floor? The quote API exposes
 * no fee, so this is derived from the catalog schedule and chain progress:
 * slots since the launch confirmed for slot-based decay (exact), chain
 * blockTime for second-based decay. Never skips blindly: an unknown/custom
 * schedule is "cannot verify", not "no wait".
 */
async function feeFloorStatus() {
  const curve = ctx.entry.fees?.curve
  if (!curve) return { ok: false, unknown: true, reason: 'catalog entry has no curve fee schedule' }
  if (curve.kind === 'flat' || (curve.openingBps != null && curve.openingBps === curve.floorBps)) {
    return { ok: true, kind: 'flat', floorBps: curve.floorBps }
  }
  let totalUnits = curve.decayPeriods != null && curve.decayPeriodLength != null ? curve.decayPeriods * curve.decayPeriodLength : null
  let unit = curve.decayUnit
  if (totalUnits == null && curve.decaySecondsEstimate != null) {
    totalUnits = curve.decaySecondsEstimate
    unit = 'seconds'
  }
  if (curve.kind !== 'decay' || totalUnits == null || (unit !== 'slots' && unit !== 'seconds')) {
    return { ok: false, unknown: true, reason: `fee schedule kind "${curve.kind}" has no verifiable decay window` }
  }
  if (unit === 'slots') {
    const cur = await connection.getSlot('confirmed')
    if (ctx.launchSlot == null) ctx.launchSlot = cur // unknown start (ACCEPTANCE_POOL): conservative
    const remainingSlots = ctx.launchSlot + totalUnits + ANTI_SNIPER_MARGIN_SLOTS - cur
    return { ok: remainingSlots <= 0, kind: 'decay', unit, totalUnits, floorBps: curve.floorBps, remainingSeconds: Math.max(0, Math.ceil(remainingSlots * 0.4)) }
  }
  const startSec = ctx.launchBlockTime ?? Math.floor((ctx.launchConfirmedAt ?? now()) / 1000)
  const remaining = startSec + totalUnits + ANTI_SNIPER_MARGIN_SECONDS - Math.floor(now() / 1000)
  return { ok: remaining <= 0, kind: 'decay', unit, totalUnits, floorBps: curve.floorBps, remainingSeconds: Math.max(0, remaining) }
}

async function waitUntilFloor() {
  const started = now()
  for (;;) {
    const st = await feeFloorStatus()
    if (st.unknown) throw fail(`cannot verify the fee is at its floor: ${st.reason}`)
    if (st.ok) return { ...st, waitedSeconds: Math.round((now() - started) / 1000) }
    if (now() - started > 45 * 60_000) throw fail('fee floor not reached within 45 minutes')
    console.log(`[wait] fee not at floor (${st.floorBps} bps) yet — ~${st.remainingSeconds}s remaining (${st.totalUnits} ${st.unit} window + margin)`)
    await sleep(Math.min(Math.max(st.remainingSeconds, 5), 30) * 1000)
  }
}

async function stepAntiSniperWait() {
  if (!SEND) {
    const curve = ctx.entry.fees?.curve
    skipSend(`anti-sniper wait: curve kind=${curve?.kind} window=${curve?.decayPeriods}x${curve?.decayPeriodLength} ${curve?.decayUnit} (~${curve?.decaySecondsEstimate ?? '?'}s) — trades would be held until the floor ${curve?.floorBps} bps is reached`)
    return { curve: curve ?? null, waited: 0 }
  }
  return waitUntilFloor()
}

async function resolveDryRunPool() {
  if (ctx.pool) return ctx.pool
  const candidates = ctx.poolCandidates ?? (await findTradeablePool(ctx.entry))
  for (const candidate of candidates.slice(0, 10)) {
    const probe = await apiFetch('/api/trade/quote', {
      method: 'POST',
      body: { poolAddress: candidate.id, side: 'buy', amountIn: '1', slippageBps: SLIPPAGE_BPS },
    })
    if (probe.status === 200) {
      ctx.pool = {
        poolAddress: candidate.id,
        baseMint: candidate.baseMint,
        listing: candidate,
        poolInfo: probe.json.poolInfo,
      }
      console.log(`[dry-run] trade target: ${candidate.name} (${candidate.symbol}) pool ${candidate.id}`)
      return ctx.pool
    }
    console.log(`[dry-run] pool ${candidate.id} not tradeable (${probe.status} ${probe.json?.error ?? ''}) — trying next`)
  }
  throw fail('no tradeable curve pool found among recent meme pools for the dry-run trade steps')
}

async function quoteAndBuild(side, amountIn, poolInfo) {
  const quoteRes = await apiFetch('/api/trade/quote', {
    method: 'POST',
    body: { poolAddress: ctx.pool.poolAddress, side, amountIn: amountIn.toString(), slippageBps: SLIPPAGE_BPS },
  })
  if (quoteRes.status !== 200) {
    throw fail(`/api/trade/quote ${side} returned ${quoteRes.status}: ${quoteRes.text.slice(0, 300)}`)
  }
  const quote = quoteRes.json
  const txRes = await apiFetch('/api/trade/tx', {
    method: 'POST',
    body: {
      poolAddress: ctx.pool.poolAddress,
      ownerPublicKey: ctx.payer.keypair.publicKey.toBase58(),
      side,
      amountIn: amountIn.toString(),
      minimumAmountOut: quote.minimumAmountOut,
      slippageBps: SLIPPAGE_BPS,
    },
  })
  if (txRes.status !== 200) {
    throw fail(`/api/trade/tx ${side} returned ${txRes.status}: ${txRes.text.slice(0, 300)}`)
  }
  const tx = Transaction.from(Buffer.from(txRes.json.transaction, 'base64'))
  const ownerKey = ctx.payer.keypair.publicKey.toBase58()
  const ownerSig = tx.signatures.find((s) => s.publicKey.toBase58() === ownerKey)
  if (ownerSig?.signature) throw fail(`${side} tx arrived signed — expected unsigned`)
  if (!tx.feePayer || tx.feePayer.toBase58() !== ownerKey) {
    throw fail(`${side} tx feePayer is ${tx.feePayer?.toBase58() ?? 'unset'} — expected ${ownerKey}`)
  }
  return { quote, tx, txResponse: txRes.json }
}

async function stepBuy() {
  if (SEND && report.progress?.boughtBaseAtoms != null) {
    ctx.boughtBaseAtoms = BigInt(report.progress.boughtBaseAtoms)
    return { resumedSkip: 'buy already done', signature: report.signatures.buy, baseDelta: report.progress.boughtBaseAtoms }
  }
  if (SEND && report.signatures.buy) {
    throw fail(`a buy was sent (${report.signatures.buy}) but its outcome is not recorded — check it on an explorer; do not buy again blindly`)
  }
  if (!SEND) await resolveDryRunPool()
  const poolInfo = ctx.pool.poolInfo ?? (await quoteInfoForPool())
  // The pool's live scaled-UI config wins; the catalog entry is the fallback.
  const multiplier = poolInfo.quoteScaledUiAmount
    ? effectiveMultiplier(poolInfo.quoteScaledUiAmount)
    : (ctx.entry.quote?.scaledUiAmountMultiplier ?? '1')
  const amountIn = displayToAtoms(BUY_AMOUNT_DISPLAY, poolInfo.quoteDecimals, multiplier)
  if (amountIn <= 0n) throw fail(`buy amount ${BUY_AMOUNT_DISPLAY} ${poolInfo.quoteSymbol} is zero atoms`)
  let floor = null
  if (SEND) floor = await waitUntilFloor() // re-verify right before the buy
  const { quote, tx } = await quoteAndBuild('buy', amountIn, poolInfo)
  ctx.buyQuote = quote
  if (!SEND) {
    const sim = await simulate(tx, 'buy')
    skipSend(`buy sign+send+confirm (${BUY_AMOUNT_DISPLAY} ${poolInfo.quoteSymbol} → base)`)
    return {
      mode: 'quote+build-only',
      pool: ctx.pool.poolAddress,
      amountIn: amountIn.toString(),
      amountOut: quote.amountOut,
      minimumAmountOut: quote.minimumAmountOut,
      simulation: sim,
    }
  }
  const owner = ctx.payer.keypair.publicKey
  const baseBefore = await tokenAtoms(owner, poolInfo.baseMint)
  const sig = await sendAndConfirm(tx, ctx.payer.keypair, 'buy')
  const baseAfter = await tokenAtoms(owner, poolInfo.baseMint)
  const delta = baseAfter - baseBefore
  ctx.boughtBaseAtoms = delta
  report.progress = { ...(report.progress ?? {}), boughtBaseAtoms: delta.toString() }
  writeReport()
  const check = assertMovedAsQuoted(delta, quote, 'buy')
  return { signature: sig, amountIn: amountIn.toString(), baseDelta: delta.toString(), feeFloor: floor, check }
}

async function quoteInfoForPool() {
  // poolInfo is carried on every quote/tx response; grab it once for the
  // dry-run path that never had a launch response.
  const res = await apiFetch('/api/trade/quote', {
    method: 'POST',
    body: { poolAddress: ctx.pool.poolAddress, side: 'buy', amountIn: '1' },
  })
  if (res.status !== 200) throw fail(`poolInfo fetch returned ${res.status}: ${res.text.slice(0, 200)}`)
  ctx.pool.poolInfo = res.json.poolInfo
  return res.json.poolInfo
}

async function stepSell() {
  if (SEND && report.progress?.sellDone) {
    return { resumedSkip: 'sell already done', signature: report.signatures.sell }
  }
  if (SEND && report.signatures.sell) {
    throw fail(`a sell was sent (${report.signatures.sell}) but its outcome is not recorded — check it on an explorer`)
  }
  const poolInfo = ctx.pool.poolInfo ?? (await quoteInfoForPool())
  let amountIn
  if (SEND) {
    if (ctx.boughtBaseAtoms <= 0n) throw fail('no purchased base balance to sell')
    amountIn = (ctx.boughtBaseAtoms * BigInt(SELL_BPS)) / 10_000n
    if (amountIn <= 0n) throw fail(`sell slice of ${ctx.boughtBaseAtoms} base atoms at ${SELL_BPS} bps is zero`)
  } else {
    // Dry-run holds no base — quote/build a small sell anyway (the endpoints
    // do not check the owner's balance; the tx would fail on-chain only).
    amountIn = 10n ** BigInt(Math.max((poolInfo.baseDecimals ?? 6) - 3, 0))
  }
  const { quote, tx } = await quoteAndBuild('sell', amountIn, poolInfo)
  ctx.sellQuote = quote
  if (!SEND) {
    // The dry-run payer bought nothing, so the sell can only fail on balance.
    const sim = await simulate(tx, 'sell', { payerHoldsInput: false })
    skipSend(`sell sign+send+confirm (${amountIn} base atoms → ${poolInfo.quoteSymbol})`)
    return {
      mode: 'quote+build-only',
      pool: ctx.pool.poolAddress,
      amountIn: amountIn.toString(),
      amountOut: quote.amountOut,
      minimumAmountOut: quote.minimumAmountOut,
      simulation: sim,
    }
  }
  const owner = ctx.payer.keypair.publicKey
  await waitUntilFloor()
  const quoteBefore = await quoteAtoms(owner, poolInfo)
  const sig = await sendAndConfirm(tx, ctx.payer.keypair, 'sell')
  const quoteAfter = await quoteAtoms(owner, poolInfo)
  // The owner also pays the network fee in SOL; the slippage check applies
  // to the quote-token delta which for non-SOL quotes is the clean signal.
  const delta = quoteAfter - quoteBefore
  const check = assertMovedAsQuoted(delta, quote, 'sell')
  report.progress = { ...(report.progress ?? {}), sellDone: true }
  writeReport()
  return { signature: sig, amountIn: amountIn.toString(), quoteDelta: delta.toString(), check }
}

/**
 * `claim_fees` — builds the unsigned creator-fee claim for the coin this run
 * launched. Fresh out of launch there is usually nothing to claim yet, so the
 * documented `409 no_claimable_fees` is a pass; a `200` must carry a
 * transaction. In dry-run there is no launch of ours, so the documented
 * `403 not_creator` on a foreign pool is also a pass — it proves the route,
 * auth check and claim path are live.
 */
async function stepClaim() {
  const poolAddress = ctx.launch?.poolAddress ?? ctx.pool?.poolAddress
  if (!poolAddress) throw fail('no pool to claim on (neither launch nor trade target resolved)')
  const creatorPublicKey = ctx.payer.keypair.publicKey.toBase58()
  const res = await apiFetch('/api/claim/tx', {
    method: 'POST',
    body: { poolAddress, creatorPublicKey },
  })
  if (res.status === 200) {
    if (!res.json?.transaction) throw fail('claim_tx returned 200 without a transaction')
    return { status: 200, claimable: res.json.claimable ?? null }
  }
  if (res.status === 409 && res.json?.error === 'no_claimable_fees') {
    return { status: 409, error: 'no_claimable_fees' }
  }
  if (!SEND && res.status === 403 && res.json?.error === 'not_creator') {
    return { status: 403, error: 'not_creator', note: 'dry-run pool is not ours — auth check proven' }
  }
  throw fail(`/api/claim/tx returned ${res.status}: ${res.text.slice(0, 300)}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`mode:      ${SEND ? (priorReport || RESUME_POOL ? 'SEND (RESUME — real transactions)' : 'SEND (real transactions)') : 'DRY-RUN (read-only + tx builds)'}`)
  console.log(`base URL:  ${BASE_URL}`)
  console.log(`RPC:       ${redactUrl(RPC_URL)}`)
  console.log(`coin:      "${COIN.name}" / $${COIN.symbol} / ${COIN.category}`)
  console.log(`report:    ${REPORT_FILE}`)

  ctx.payer = loadPayer()
  report.payer = { publicKey: ctx.payer.keypair.publicKey.toBase58(), source: ctx.payer.source }

  await step('fetch skill docs', null, stepDocs)
  await step('list configs — memecoin default is a creator-fee config', 'list_configs', stepConfigs)
  await step('resolve the full run plan (+ plan hash)', null, stepPlan)

  // Gate: nothing below this line sends anything without a matching approval.
  let approval = null
  if (SEND) {
    approval = checkApproval(ctx.plan)
    prepareResumeAndGuard()
  }
  report.approval = approval
    ? { file: APPROVAL_FILE, planHash: approval.planHash, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt }
    : null
  writeReport()

  await step('pre-flight: payer SOL + quote-token balances', null, stepPreflight)
  await step('launch token (build + sign + send + confirm)', 'launch_token', () => stepLaunch(ctx.payer))
  await step('find the coin via search (mint, symbol, name) AND list', 'list_pools', stepPools)
  await step('wait out the anti-sniper fee window', null, stepAntiSniperWait)
  await step('buy: quote + tx + sign + send + confirm + balance check', 'trade_quote/trade_tx', stepBuy)
  await step('sell part of the balance: quote + tx + sign + send + confirm + balance check', 'trade_quote/trade_tx', stepSell)
  await step('claim creator fees (tx build; 409 no_claimable_fees acceptable pre-volume)', 'claim_fees', stepClaim)

  report.result = SEND ? 'pass' : 'dry-run-pass'
  writeReport({ final: true })
  console.log(`\n=== ${report.result === 'pass' ? 'ACCEPTANCE PASSED' : 'DRY-RUN PASSED'} ===`)
  if (SEND) {
    console.log('Signatures:')
    for (const [label, sig] of Object.entries(report.signatures)) console.log(`  ${label}: ${sig}`)
  } else {
    console.log(`Plan hash: ${ctx.plan.planHash}`)
    console.log('No transaction was signed or sent. To send: the service must be deployed AND the')
    console.log('owner approves this plan (write acceptance-approval.json with this planHash).')
  }
  console.log(`Report: ${REPORT_FILE}`)
}

main().catch((err) => {
  report.result = 'error'
  // Message only, sanitized — never a stack (could embed RPC URLs / secrets).
  report.error = sanitize(err instanceof Error ? err.message : String(err))
  writeReport({ final: true })
  console.error(err?.isStepFailure ? `REFUSED: ${sanitize(err.message)}` : `ERROR: ${report.error}`)
  printRecovery()
  process.exit(1)
})
