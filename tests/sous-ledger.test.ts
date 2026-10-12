// THE SOUS LEDGER (HP round): 0600 from the first byte, every string through
// scrub(), folded by token, 30 days, and the rows the inbox floats.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SousLedger, SOUS_LEDGER_TTL_MS } from '../src/main/sous-ledger'
import { ownerSecretPaths } from '../src/main/owner-secrets'

const DAY = 24 * 60 * 60 * 1000

describe('SousLedger', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const fresh = (now: () => number) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sous-ledger-'))
    dirs.push(dir)
    return { ledger: new SousLedger(path.join(dir, 'nested', 'sous-decisions.jsonl'), now), dir }
  }

  it('is written 0600 inside a 0700 directory, one JSON line per patch', () => {
    let t = 1_000
    const { ledger } = fresh(() => t)
    ledger.write({ token: 'a', at: t, sentence: 'push the branch', domain: 'repo', exposure: 2, mode: 'paused', target: { id: 'forge', name: 'Forge' }, alternates: [], outcome: 'pending' })
    t = 2_000
    ledger.write({ token: 'a', ownerResponse: 'send-anyway', proposalText: 'push the branch\n\nBoundaries: push only after the check passes', deliveredTo: 'forge' })
    expect(statSync(ledger.path()).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(ledger.path())).mode & 0o777).toBe(0o700)
    expect(readFileSync(ledger.path(), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('folds by token — the newest row wins field by field — and keeps the mint time', () => {
    let t = 1_000
    const { ledger } = fresh(() => t)
    ledger.write({ token: 'a', at: t, sentence: 'push the branch', exposure: 2, mode: 'paused', outcome: 'pending' })
    t = 5_000
    ledger.write({ token: 'a', dispatchId: 'd1', outcome: 'delivered' })
    const row = ledger.get('a')
    expect(row).toMatchObject({ token: 'a', at: 1_000, updatedAt: 5_000, sentence: 'push the branch', exposure: 2, mode: 'paused', dispatchId: 'd1', outcome: 'delivered' })
  })

  it('rows older than 30 days are gone on read', () => {
    let t = 0
    const { ledger } = fresh(() => t)
    ledger.write({ token: 'old', at: t, sentence: 'old', outcome: 'failed' })
    t = SOUS_LEDGER_TTL_MS + DAY
    ledger.write({ token: 'new', at: t, sentence: 'new', outcome: 'failed' })
    expect(ledger.rows().map((r) => r.token)).toEqual(['new'])
  })

  it('stuck() is the failed/interrupted deliveries with a proposal, minus the dismissed; dismiss persists', () => {
    let t = 1_000
    const { ledger } = fresh(() => t)
    ledger.write({ token: 'a', at: t, sentence: 'a', outcome: 'failed', proposalText: 'a', deliveredTo: 'forge' })
    ledger.write({ token: 'b', at: t, sentence: 'b', outcome: 'interrupted', proposalText: 'b', deliveredTo: 'tinker' })
    ledger.write({ token: 'c', at: t, sentence: 'c', outcome: 'delivered', proposalText: 'c', deliveredTo: 'forge' })
    ledger.write({ token: 'd', at: t, sentence: 'd', outcome: 'failed' })
    expect(ledger.stuck().map((r) => r.token).sort()).toEqual(['a', 'b'])
    expect(ledger.dismiss('a')).toBe(true)
    expect(ledger.dismiss('zzz')).toBe(false)
    const again = new SousLedger(ledger.path(), () => t)
    expect(again.stuck().map((r) => r.token)).toEqual(['b'])
  })

  it('a change event fires on every write, so the inbox can rebuild', () => {
    const { ledger } = fresh(() => 1)
    let changes = 0
    ledger.on('change', () => (changes += 1))
    ledger.write({ token: 'a', at: 1 })
    ledger.dismiss('a')
    expect(changes).toBe(2)
  })

  it('every string goes through scrub() — the identity shim today, Tinker\'s on merge', () => {
    const { ledger } = fresh(() => 1)
    ledger.write({ token: 'a', at: 1, sentence: 'use the pairing token' })
    // "pairing token" must survive any scrub (the contract forbids word lists); the shim is the identity
    expect(ledger.get('a')?.sentence).toBe('use the pairing token')
  })

  it('the ledger path is in the served deny list', () => {
    expect(ownerSecretPaths('/tmp/base', '/Users/x').some((p) => p.endsWith('/.cookrew/sous-decisions.jsonl'))).toBe(true)
  })
})
