/**
 * DD-S-2 dependency pins — the ticket's mechanical guarantees, pinned.
 *
 * The skill must quote and build exactly the way the app does: the DBC SDK,
 * web3.js and anchor are exact-pinned to the app's versions
 * (launchpad-mobile-redesign/package.json), the install resolves to ONE
 * anchor and ONE bn.js, `engines` pins the Node major, and DEPLOY.md's
 * documented install/run commands stay reproducible (`npm ci`, a
 * digest-pinned image).
 *
 * Run with: `node --test tests/` (or `npm test`)
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const readJson = (rel: string) => JSON.parse(read(rel))

const pkg = () => readJson('package.json')
const lock = () => readJson('package-lock.json')

describe('dependency pins (DD-S-2)', () => {
  it('the DBC SDK, web3.js and anchor are exact-pinned to the app versions', () => {
    const deps = pkg().dependencies
    for (const [name, expected] of [
      ['@meteora-ag/dynamic-bonding-curve-sdk', '1.5.13'],
      ['@solana/web3.js', '1.98.4'],
      ['@coral-xyz/anchor', '0.31.1'],
    ] as const) {
      assert.equal(deps[name], expected, `${name} must be exactly ${expected}`)
    }
  })

  it('the lockfile resolves ONE anchor and ONE bn.js', () => {
    const paths = Object.keys(lock().packages)
    const anchors = paths.filter((p) => /(^|\/)node_modules\/@coral-xyz\/anchor$/.test(p))
    const bnjs = paths.filter((p) => /(^|\/)node_modules\/bn\.js$/.test(p))
    assert.deepEqual(anchors, ['node_modules/@coral-xyz/anchor'])
    assert.deepEqual(bnjs, ['node_modules/bn.js'])
    assert.equal(lock().packages['node_modules/@coral-xyz/anchor'].version, '0.31.1')
  })

  it('engines pins the Node major', () => {
    assert.match(String(pkg().engines?.node), /^24(\.|$)/)
  })

  it('DEPLOY.md installs with npm ci and references the image by digest', () => {
    const deploy = read('DEPLOY.md')
    assert.ok(/npm ci/.test(deploy), 'DEPLOY.md does not mention npm ci')
    assert.ok(
      /FROM node:24-alpine@sha256:[0-9a-f]{64}/.test(deploy),
      'DEPLOY.md Dockerfile must reference a digest-pinned node image',
    )
    assert.ok(!/FROM node:\d+-\w+\s+AS/.test(deploy), 'a floating node tag slipped back in')
  })

  it('next.config.js carries the serverExternalPackages migration note', () => {
    const cfg = read('next.config.js')
    assert.ok(/serverExternalPackages/.test(cfg), 'missing the Next 15 rename note')
  })
})
