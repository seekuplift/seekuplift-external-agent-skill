#!/usr/bin/env node
/**
 * scripts/acceptance.mjs — real-coin acceptance for the Meteora launchpad
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
 *       a. the approval file exists and approves the exact coin name+symbol
 *          being launched (default ./acceptance-approval.json, override with
 *          ACCEPTANCE_APPROVAL_FILE). Format:
 *            { "approved": true, "name": "…", "symbol": "…",
 *              "approvedBy": "<owner>", "approvedAt": "<iso>", "note": "…" }
 *          This documents that the owner approved the coin details in chat.
 *       b. --dry-run is NOT also passed.
 *       c. when the base URL is loopback, ACCEPTANCE_ALLOW_LOCAL_SEND=yes is
 *          set (real sends belong against the deployed service).
 *     Every signature is printed and written to the report file.
 *
 * USAGE
 *   node scripts/acceptance.mjs --dry-run --base-url http://localhost:3001
 *   node scripts/acceptance.mjs --send --base-url https://skill.seekuplift.com
 *
 * ENV
 *   ACCEPTANCE_BASE_URL      service base URL (default https://skill.seekuplift.com)
 *   ACCEPTANCE_KEYPAIR       path to a Solana keypair JSON file (byte array).
 *                            Dry-run falls back to an ephemeral keypair when
 *                            unset; --send refuses without it.
 *   ACCEPTANCE_RPC           Solana mainnet RPC (default SOLANA_RPC_URL or
 *                            https://api.mainnet-beta.solana.com)
 *   ACCEPTANCE_APPROVAL_FILE approval file path (default ./acceptance-approval.json)
 *   ACCEPTANCE_REPORT        report output path (default ./acceptance-report-<ts>.json)
 *   ACCEPTANCE_IMAGE         path to a PNG/JPEG to upload instead of the
 *                            generated acceptance image
 *   ACCEPTANCE_COIN_NAME / ACCEPTANCE_COIN_SYMBOL / ACCEPTANCE_COIN_DESC
 *                            override the proposed coin details (must match
 *                            the approval file in --send mode)
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
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
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
    'Real-coin acceptance launch for the Meteora launchpad agent skill: ' +
      'one creator-fee memecoin launched, found, bought and sold end-to-end by ' +
      'scripts/acceptance.mjs after owner approval.',
  category: 'meme',
}
const BUY_AMOUNT_DISPLAY = process.env.ACCEPTANCE_BUY_AMOUNT || '10'
const SELL_BPS = Number(process.env.ACCEPTANCE_SELL_BPS || '5000')
const SLIPPAGE_BPS = Number(process.env.ACCEPTANCE_SLIPPAGE_BPS || '100')
const ANTI_SNIPER_MARGIN_SECONDS = 60

// ─── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    baseUrl: null,
    dryRun: false,
    send: false,
    rpc: null,
    report: null,
    approval: null,
    image: null,
    launchBuild: true,
    help: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => argv[++i]
    if (a === '--base-url') args.baseUrl = take()
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--send') args.send = true
    else if (a === '--rpc') args.rpc = take()
    else if (a === '--report') args.report = take()
    else if (a === '--approval') args.approval = take()
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
      '[--rpc URL] [--report PATH] [--approval PATH] [--image PATH] [--no-launch-build]',
  )
  process.exit(0)
}

const BASE_URL = (
  args.baseUrl ||
  process.env.ACCEPTANCE_BASE_URL ||
  'https://skill.seekuplift.com'
).replace(/\/+$/, '')
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
      headers: body ? { 'content-type': 'application/json' } : undefined,
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
    const ephemeral = Keypair.generate()
    console.log(`[setup] no ACCEPTANCE_KEYPAIR — dry-run uses ephemeral payer ${ephemeral.publicKey.toBase58()}`)
    return { keypair: ephemeral, source: 'ephemeral (dry-run)' }
  }
  const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
  if (!Array.isArray(raw)) {
    throw fail(`ACCEPTANCE_KEYPAIR file ${keypairPath} is not a JSON byte array`)
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(raw))
  console.log(`[setup] payer/owner ${keypair.publicKey.toBase58()} from ${keypairPath}`)
  return { keypair, source: keypairPath }
}

// ─── Approval gate (--send only) ──────────────────────────────────────────────
function checkApproval() {
  if (!fs.existsSync(APPROVAL_FILE)) {
    throw fail(
      `--send refused: no approval file at ${APPROVAL_FILE}. ` +
        'The owner must approve the coin details in chat first; record it as ' +
        '{ "approved": true, "name": "<coin name>", "symbol": "<symbol>", "approvedBy": "…", "approvedAt": "…" }',
    )
  }
  let approval
  try {
    approval = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8'))
  } catch (err) {
    throw fail(`--send refused: approval file ${APPROVAL_FILE} is not valid JSON: ${err}`)
  }
  if (approval?.approved !== true) {
    throw fail(`--send refused: approval file ${APPROVAL_FILE} does not contain "approved": true`)
  }
  if (approval.name !== COIN.name || approval.symbol !== COIN.symbol) {
    throw fail(
      `--send refused: approval file approves "${approval.name}" / "${approval.symbol}" ` +
        `but this run launches "${COIN.name}" / "${COIN.symbol}". Re-approve the new details.`,
    )
  }
  if (isLoopback(BASE_URL) && process.env.ACCEPTANCE_ALLOW_LOCAL_SEND !== 'yes') {
    throw fail(
      `--send refused: base URL ${BASE_URL} is loopback. Real sends belong against the ` +
        'deployed service; set ACCEPTANCE_ALLOW_LOCAL_SEND=yes only if you are certain.',
    )
  }
  console.log(
    `[gate] owner approval on file: "${approval.name}" / "${approval.symbol}" ` +
      `approved by ${approval.approvedBy ?? '?'} at ${approval.approvedAt ?? '?'}`,
  )
  return approval
}

// ─── Run state / reporting ────────────────────────────────────────────────────
const connection = new Connection(RPC_URL, 'confirmed')
const report = {
  ticket: '09-real-coin-acceptance',
  mode: SEND ? 'send' : 'dry-run',
  baseUrl: BASE_URL,
  rpcUrl: RPC_URL,
  startedAt: new Date().toISOString(),
  coin: { ...COIN, buyAmountDisplay: BUY_AMOUNT_DISPLAY, sellBps: SELL_BPS, slippageBps: SLIPPAGE_BPS },
  steps: [],
  signatures: {},
  result: 'running',
}

function writeReport() {
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n')
}

let stepIndex = 0
const ctx = {
  capabilities: [],
  entry: null, // chosen catalog entry
  launch: null, // launch response
  pool: null, // pool used for trades (dry-run: an existing curve pool)
  launchConfirmedAt: null,
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
    console.log(`--- PASS ${name} (${now() - started} ms)`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    report.steps.push({ step: stepIndex, name, capability, status: 'fail', error: detail, ms: now() - started })
    report.result = 'fail'
    writeReport()
    console.error(`--- FAIL ${name}: ${detail}`)
    console.error(`Report written to ${REPORT_FILE}`)
    process.exit(1)
  }
}

function skipSend(what) {
  console.log(`[SKIP-SEND] ${what} — dry-run does not sign, send or confirm`)
}

async function simulate(tx, label) {
  // Read-only mainnet simulation (sigVerify off) — an unfunded payer yields
  // the expected funds-class error; an InstructionError would mean the
  // built instruction itself is rejected and is a REAL build bug.
  try {
    const result = await connection.simulateTransaction(tx)
    const err = result.value.err
    const errJson = JSON.stringify(err)
    console.log(`[simulate] ${label}: unitsConsumed=${result.value.unitsConsumed} err=${errJson}`)
    if (err && typeof err === 'object' && 'InstructionError' in err) {
      throw fail(`${label} simulation failed at instruction level — real build bug: ${errJson}`)
    }
    return { unitsConsumed: result.value.unitsConsumed ?? null, err: err ?? null }
  } catch (err) {
    if (err.isStepFailure) throw err
    console.log(`[simulate] ${label}: RPC simulation call failed (non-fatal): ${err}`)
    return { error: String(err) }
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
const KNOWN_CAPABILITIES = ['list_configs', 'launch_token', 'trade_quote', 'trade_tx', 'list_pools']

async function stepDocs() {
  const md = await apiFetch('/skill.md')
  if (md.status !== 200) throw fail(`/skill.md returned ${md.status}`)
  if (!md.text.includes('list_configs')) throw fail('/skill.md does not look like the skill document')
  const js = await apiFetch('/skill.json')
  if (js.status !== 200 || !js.json) throw fail(`/skill.json returned ${js.status} or non-JSON`)
  const caps = (js.json.capabilities ?? []).map((c) => c?.id).filter(Boolean)
  for (const required of KNOWN_CAPABILITIES) {
    if (!caps.includes(required)) throw fail(`skill.json is missing capability "${required}"`)
  }
  for (const cap of caps) {
    if (!KNOWN_CAPABILITIES.includes(cap)) {
      // One-to-one contract: a new capability needs a new acceptance step.
      throw fail(`skill.json advertises capability "${cap}" with no acceptance step — add one`)
    }
  }
  ctx.capabilities = caps
  return { skillMdBytes: md.text.length, capabilities: caps, version: js.json.version ?? null }
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

async function stepLaunch(payer) {
  if (!args.launchBuild) {
    skipSend('launch build (--no-launch-build): nothing was uploaded or built')
    return { skipped: 'no-launch-build' }
  }
  const entry = ctx.entry
  const image = loadImage()
  report.coin.image = image.source // the proposal's image field, for the report
  const firstBuyDisplay =
    entry.supportsFirstBuy
      ? (process.env.ACCEPTANCE_FIRST_BUY ?? entry.quote.firstBuyDefault ?? '0')
      : null
  const body = {
    configKey: entry.configKey,
    category: COIN.category,
    name: COIN.name,
    symbol: COIN.symbol,
    description: COIN.description,
    image: image.base64,
    payerPublicKey: payer.keypair.publicKey.toBase58(),
    ...(firstBuyDisplay && firstBuyDisplay !== '0' ? { firstBuyAmount: firstBuyDisplay } : {}),
  }

  // Post without a donation first — exactly what a naive agent does. When
  // the backend offers causes the service refuses with causesOffered before
  // spending any upload budget; re-post with the first shipping cause.
  let res = await apiFetch('/api/launch', { method: 'POST', body })
  let donation = null
  if (res.status === 400 && res.json?.error === 'donation_required') {
    const offered = res.json.causesOffered ?? []
    if (offered.length === 0) throw fail('donation_required but causesOffered is empty')
    donation = { mode: 'cause', cause: offered[0] }
    console.log(`[launch] donation required — re-posting with donation ${JSON.stringify(donation)}`)
    res = await apiFetch('/api/launch', { method: 'POST', body: { ...body, donation } })
  }
  if (res.status !== 200) {
    throw fail(`/api/launch returned ${res.status}: ${res.text.slice(0, 500)}`)
  }
  const launch = res.json
  for (const field of ['transaction', 'mintAddress', 'poolAddress', 'metadataUrl', 'configKey']) {
    if (!launch[field]) throw fail(`/api/launch response missing ${field}`)
  }
  const tx = Transaction.from(Buffer.from(launch.transaction, 'base64'))
  const payerKey = payer.keypair.publicKey.toBase58()
  const mintSig = tx.signatures.find((s) => s.publicKey.toBase58() === launch.mintAddress)
  const payerSig = tx.signatures.find((s) => s.publicKey.toBase58() === payerKey)
  if (!mintSig?.signature) throw fail('launch tx is missing the mint partial signature')
  if (payerSig?.signature) throw fail('launch tx payer slot is unexpectedly signed')
  if (!tx.feePayer || tx.feePayer.toBase58() !== payerKey) {
    throw fail(`launch tx feePayer is ${tx.feePayer?.toBase58() ?? 'unset'} — expected ${payerKey}`)
  }
  const sim = await simulate(tx, 'launch')

  ctx.launch = { ...launch, donation, firstBuyAmount: firstBuyDisplay }
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
      firstBuyAmount: firstBuyDisplay,
      donation,
      simulation: sim,
    }
  }
  const sig = await sendAndConfirm(tx, payer.keypair, 'launch')
  ctx.launchConfirmedAt = now()
  return {
    mintAddress: launch.mintAddress,
    poolAddress: launch.poolAddress,
    signature: sig,
    firstBuyAmount: firstBuyDisplay,
    donation,
  }
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
    const deadline = now() + 180_000
    let found = null
    while (now() < deadline) {
      const res = await apiFetch(`/api/pools?search=${encodeURIComponent(ctx.launch.mintAddress)}`)
      if (res.status === 200) {
        found = (res.json?.pools ?? []).find((p) => p.id === ctx.launch.poolAddress) ?? null
        if (found) break
      }
      await sleep(10_000)
    }
    if (!found) throw fail(`launched pool ${ctx.launch.poolAddress} never appeared in /api/pools search`)
    const list = await apiFetch('/api/pools?category=meme&lifecycle=new&sortBy=createdAt&limit=50')
    if (list.status !== 200) throw fail(`/api/pools list returned ${list.status}`)
    const listed = (list.json?.pools ?? []).find((p) => p.id === ctx.launch.poolAddress)
    if (!listed) throw fail(`launched pool ${ctx.launch.poolAddress} missing from the meme/new list`)
    ctx.pool = { poolAddress: ctx.launch.poolAddress, baseMint: ctx.launch.mintAddress, listing: listed }
    return { foundBySearch: found.id, foundByList: listed.id }
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

async function stepAntiSniperWait() {
  const seconds = ctx.entry.fees?.curve?.decaySecondsEstimate
  if (seconds == null) {
    return { window: null, note: 'launch config has no decay window (flat/custom curve) — no wait needed' }
  }
  const waitMs = (seconds + ANTI_SNIPER_MARGIN_SECONDS) * 1000
  if (!SEND) {
    skipSend(`anti-sniper wait: trades would be held ~${seconds}s + ${ANTI_SNIPER_MARGIN_SECONDS}s margin after launch`)
    return { window: seconds, margin: ANTI_SNIPER_MARGIN_SECONDS, waited: 0 }
  }
  const until = (ctx.launchConfirmedAt ?? now()) + waitMs
  const remaining = until - now()
  console.log(`[wait] anti-sniper window ${seconds}s (+${ANTI_SNIPER_MARGIN_SECONDS}s margin) — waiting ${Math.ceil(Math.max(remaining, 0) / 1000)}s`)
  if (remaining > 0) await sleep(remaining)
  return { window: seconds, margin: ANTI_SNIPER_MARGIN_SECONDS, waitedSeconds: Math.ceil(Math.max(remaining, 0) / 1000) }
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
  if (!SEND) await resolveDryRunPool()
  const poolInfo = ctx.pool.poolInfo ?? (await quoteInfoForPool())
  // The pool's live scaled-UI config wins; the catalog entry is the fallback.
  const multiplier = poolInfo.quoteScaledUiAmount
    ? effectiveMultiplier(poolInfo.quoteScaledUiAmount)
    : (ctx.entry.quote?.scaledUiAmountMultiplier ?? '1')
  const amountIn = displayToAtoms(BUY_AMOUNT_DISPLAY, poolInfo.quoteDecimals, multiplier)
  if (amountIn <= 0n) throw fail(`buy amount ${BUY_AMOUNT_DISPLAY} ${poolInfo.quoteSymbol} is zero atoms`)
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
  const check = assertMovedAsQuoted(delta, quote, 'buy')
  return { signature: sig, amountIn: amountIn.toString(), baseDelta: delta.toString(), check }
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
    const sim = await simulate(tx, 'sell')
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
  const quoteBefore = await quoteAtoms(owner, poolInfo)
  const sig = await sendAndConfirm(tx, ctx.payer.keypair, 'sell')
  const quoteAfter = await quoteAtoms(owner, poolInfo)
  // The owner also pays the network fee in SOL; the slippage check applies
  // to the quote-token delta which for non-SOL quotes is the clean signal.
  const delta = quoteAfter - quoteBefore
  const check = assertMovedAsQuoted(delta, quote, 'sell')
  return { signature: sig, amountIn: amountIn.toString(), quoteDelta: delta.toString(), check }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`mode:      ${SEND ? 'SEND (real transactions)' : 'DRY-RUN (read-only + tx builds)'}`)
  console.log(`base URL:  ${BASE_URL}`)
  console.log(`RPC:       ${RPC_URL}`)
  console.log(`coin:      "${COIN.name}" / $${COIN.symbol} / ${COIN.category}`)
  console.log(`report:    ${REPORT_FILE}`)

  let approval = null
  if (SEND) approval = checkApproval()
  report.approval = approval
    ? { file: APPROVAL_FILE, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt }
    : null

  ctx.payer = loadPayer()
  report.payer = { publicKey: ctx.payer.keypair.publicKey.toBase58(), source: ctx.payer.source }

  await step('fetch skill docs', null, stepDocs)
  await step('list configs — memecoin default is a creator-fee config', 'list_configs', stepConfigs)
  await step('launch token (build + sign + send + confirm)', 'launch_token', () => stepLaunch(ctx.payer))
  await step('find the coin via search AND list', 'list_pools', stepPools)
  await step('wait out the anti-sniper fee window', null, stepAntiSniperWait)
  await step('buy: quote + tx + sign + send + confirm + balance check', 'trade_quote/trade_tx', stepBuy)
  await step('sell part of the balance: quote + tx + sign + send + confirm + balance check', 'trade_quote/trade_tx', stepSell)

  report.result = SEND ? 'pass' : 'dry-run-pass'
  writeReport()
  console.log(`\n=== ${report.result === 'pass' ? 'ACCEPTANCE PASSED' : 'DRY-RUN PASSED'} ===`)
  if (SEND) {
    console.log('Signatures:')
    for (const [label, sig] of Object.entries(report.signatures)) console.log(`  ${label}: ${sig}`)
  } else {
    console.log('No transaction was signed or sent. Re-run with --send only after the')
    console.log('service is deployed AND the owner approves the coin details in chat.')
  }
  console.log(`Report: ${REPORT_FILE}`)
}

main().catch((err) => {
  report.result = 'error'
  report.error = err instanceof Error ? err.stack ?? err.message : String(err)
  writeReport()
  // Gate/setup refusals print the message alone — a stack is noise there.
  console.error(err?.isStepFailure ? `REFUSED: ${err.message}` : err)
  process.exit(1)
})
