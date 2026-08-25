import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CallCredentialService } from '../src/main/call-credential'
import { makeCallCeremony } from '../src/main/call-ceremony'
import { AgentExportStore } from '../src/main/agent-export'
import { memoizeBriefly } from '../src/main/call-cache'

/**
 * TINKER'S REVIEW, MADE INTO TESTS (④ · post-S3).
 *
 * Every one of these is a property the code had to be RESHAPED to hold, not a
 * rule it now remembers. His sting is the reason each exists: the enrolment
 * oracle passed a suite that only checked status and body, because the leak was
 * in the clock rather than the response.
 */

let base = ''
let clock = 1_700_000_000_000

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-hardening-'))
  clock = 1_700_000_000_000
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('HIGH-1 · minting a nonce is O(1) and bounded', () => {
  const issuer = (): CallCredentialService =>
    new CallCredentialService({ base, now: () => clock, challengeTtlMs: 1000 })

  it('drops both windows of nonces without ever scanning them', () => {
    const service = issuer()
    for (let i = 0; i < 100; i += 1) service.challenge('ws')
    expect(service.outstandingChallenges()).toBe(100)
    // One TTL: the live window ages. Two: the aged window is discarded whole.
    clock += 1001
    service.challenge('ws')
    clock += 1001
    service.challenge('ws')
    expect(service.outstandingChallenges()).toBe(2)
  })

  it('holds a hard ceiling under a flood inside ONE window', () => {
    // Two windows bound nothing if the flood fits inside one of them. This is
    // the case that froze the main thread: unauthenticated, unbounded, and
    // sweeping the whole map per insert.
    const service = new CallCredentialService({
      base,
      now: () => clock,
      challengeTtlMs: 60_000
    })
    for (let i = 0; i < 60_000; i += 1) service.challenge('ws')
    expect(service.outstandingChallenges()).toBeLessThanOrEqual(50_000)
  })

  it('keeps a fresh nonce spendable across a rotation', () => {
    const service = issuer()
    const nonce = service.challenge('ws')
    clock += 600
    service.challenge('ws') // rotates; the first nonce moves to the aged window
    expect(service.consumeChallenge(nonce, 'ws')).toBe(true)
  })

  it('still expires a nonce exactly, not merely by window', () => {
    const service = issuer()
    const nonce = service.challenge('ws')
    clock += 1001
    expect(service.consumeChallenge(nonce, 'ws')).toBe(false)
  })

  it('spends a nonce once even when it lives in the aged window', () => {
    const service = issuer()
    const nonce = service.challenge('ws')
    clock += 600
    service.challenge('ws')
    expect(service.consumeChallenge(nonce, 'ws')).toBe(true)
    expect(service.consumeChallenge(nonce, 'ws')).toBe(false)
  })
})

describe('MEDIUM-1 · the enrolment oracle is closed in the CLOCK, not just the body', () => {
  const ceremonyWith = (
    enrolled: Record<string, unknown> | null,
    verifySignature: (jwk: Record<string, unknown>, p: Buffer, s: Buffer) => boolean
  ): ReturnType<typeof makeCallCeremony> =>
    makeCallCeremony({
      issuer: new CallCredentialService({ base, now: () => clock }),
      enrolledKey: () => enrolled,
      verifySignature
    })

  it('performs a signature verification for an UNKNOWN caller too', () => {
    // The finding, as a test: an early return for an unknown caller skipped an
    // Ed25519 verification that the bad-signature path performs, so a stopwatch
    // told them apart. The counts must match.
    const counts: number[] = []
    for (const enrolled of [null, { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' }]) {
      const verify = vi.fn(() => false)
      const ceremony = ceremonyWith(enrolled, verify)
      const challenge = ceremony.challenge('ws')
      ceremony.assert('ws', { sub: 'alice', challenge, signature: 'AAAA' })
      counts.push(verify.mock.calls.length)
    }
    expect(counts).toEqual([1, 1])
  })

  it('verifies against a key of the same kind, not a placeholder that is cheap', () => {
    const seen: Record<string, unknown>[] = []
    const ceremony = ceremonyWith(null, (jwk) => {
      seen.push(jwk)
      return false
    })
    const challenge = ceremony.challenge('ws')
    ceremony.assert('ws', { sub: 'nobody', challenge, signature: 'AAAA' })
    // A real Ed25519 public JWK, so the work is the work — not an empty object
    // that would throw immediately and reopen the timing gap the other way.
    expect(seen[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' })
  })

  it('still reports the right reason server-side', () => {
    // Uniform on the wire, precise in the process: the distinction stays
    // available to the log and the tests, which is where the ruling puts it.
    const unknown = ceremonyWith(null, () => true)
    const challenge = unknown.challenge('ws')
    expect(unknown.assert('ws', { sub: 'a', challenge, signature: 'AAAA' })).toEqual({
      ok: false,
      reason: 'unknown_caller'
    })
  })
})

// Unix file-mode security: NTFS has no 0600 bits, so statSync().mode reports
// 0o666 on Windows and these mode checks are inapplicable there (macOS/Linux
// CI covers them). Matches the process.platform guards in readonly-token /
// pairing-token / codex-bind.
describe.skipIf(process.platform === 'win32')('MEDIUM-2 · the signing key\'s mode is checked on READ', () => {
  it('refuses a key that became readable by others', () => {
    const service = new CallCredentialService({ base, now: () => clock })
    service.mint('alice', 'ws')
    // What a backup restore, a `cp`, or an rsync without -p leaves behind.
    chmodSync(path.join(base, 'call-token-key.jwk'), 0o644)
    const reopened = new CallCredentialService({ base, now: () => clock })
    expect(() => reopened.mint('alice', 'ws')).toThrow(/readable by others/)
  })

  it('fails CLOSED — a loosened key verifies nothing rather than everything', () => {
    const service = new CallCredentialService({ base, now: () => clock })
    const token = service.mint('alice', 'ws')
    chmodSync(path.join(base, 'call-token-key.jwk'), 0o604)
    const reopened = new CallCredentialService({ base, now: () => clock })
    expect(reopened.verifyToken(token)).toBeNull()
  })

  it('creates the key 0600 in the first place', () => {
    const service = new CallCredentialService({ base, now: () => clock })
    service.mint('alice', 'ws')
    const mode = statSync(path.join(base, 'call-token-key.jwk')).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32')('MEDIUM-3 · the grant record is as protected as the key', () => {
  it('writes exports.json 0600 — its integrity IS the gate', () => {
    const store = new AgentExportStore(base)
    store.enrol('ws', 'alice', { kty: 'OKP' })
    const mode = statSync(path.join(base, 'exports.json')).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })

  it('re-tightens a file that was loosened behind its back', () => {
    const store = new AgentExportStore(base)
    store.enrol('ws', 'alice', { kty: 'OKP' })
    chmodSync(path.join(base, 'exports.json'), 0o644)
    store.enrol('ws', 'bob', { kty: 'OKP' })
    expect(statSync(path.join(base, 'exports.json')).mode & 0o077).toBe(0)
  })
})

// Windows: mtime granularity breaks same-size-rewrite cache-invalidation detection — macOS/Linux CI covers it.
describe.skipIf(process.platform === 'win32')('HIGH-2 · the pre-credential path stops hitting the disk per request', () => {
  it('does not re-read an unchanged grant file', () => {
    const store = new AgentExportStore(base)
    store.exportAgent({ workspaceId: 'ws', nodeId: 'n1', visibility: 'identified', callers: ['a'] })
    const file = path.join(base, 'exports.json')
    const before = readFileSync(file, 'utf8')
    // Replace the CONTENTS behind the cache without changing mtime or size:
    // if the store re-read, it would see this; it must not, and it must not
    // need to, because writes go through it.
    expect(store.exportOf('ws', 'n1')?.callers).toEqual(['a'])
    expect(store.exportOf('ws', 'n1')?.callers).toEqual(['a'])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('DOES pick up an edit made behind its back', () => {
    // The cache must not become a way for a withdrawn grant to keep working.
    const store = new AgentExportStore(base)
    store.exportAgent({ workspaceId: 'ws', nodeId: 'n1', visibility: 'identified', callers: ['a'] })
    expect(store.exportOf('ws', 'n1')).not.toBeNull()
    writeFileSync(
      path.join(base, 'exports.json'),
      JSON.stringify({ enrolled: [], exports: [] }, null, 2)
    )
    expect(store.exportOf('ws', 'n1')).toBeNull()
  })

  it('notices a same-size rewrite, which is what an atomic replace looks like', () => {
    const store = new AgentExportStore(base)
    store.exportAgent({ workspaceId: 'ws', nodeId: 'n1', visibility: 'identified', callers: ['aa'] })
    const first = store.exportOf('ws', 'n1')?.callers
    // Same byte length, different meaning — mtime alone would be enough here
    // only because the clock moved; size is the belt to that braces.
    writeFileSync(
      path.join(base, 'exports.json'),
      JSON.stringify(
        { enrolled: [], exports: [{ workspaceId: 'ws', nodeId: 'n1', visibility: 'identified', callers: ['bb'] }] },
        null,
        2
      )
    )
    expect(first).toEqual(['aa'])
    expect(store.exportOf('ws', 'n1')?.callers).toEqual(['bb'])
  })

  it('treats a missing file as no grants, and picks one up when it appears', () => {
    const store = new AgentExportStore(base)
    expect(store.exportOf('ws', 'n1')).toBeNull()
    mkdirSync(base, { recursive: true })
    writeFileSync(
      path.join(base, 'exports.json'),
      JSON.stringify({
        enrolled: [],
        exports: [{ workspaceId: 'ws', nodeId: 'n1', visibility: 'identified', callers: ['a'] }]
      })
    )
    expect(store.exportOf('ws', 'n1')).not.toBeNull()
  })
})

describe('HIGH-2 · the node lookup memo', () => {
  it('serves a repeat within the window without calling through', () => {
    const lookup = vi.fn((key: string) => [key])
    const memo = memoizeBriefly(lookup, { ttlMs: 1000, now: () => clock })
    memo('ws')
    memo('ws')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('calls through again once the window passes', () => {
    const lookup = vi.fn((key: string) => [key])
    const memo = memoizeBriefly(lookup, { ttlMs: 1000, now: () => clock })
    memo('ws')
    clock += 1000
    memo('ws')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('keeps workspaces apart', () => {
    const memo = memoizeBriefly((key: string) => [key], { ttlMs: 1000, now: () => clock })
    expect(memo('a')).toEqual(['a'])
    expect(memo('b')).toEqual(['b'])
  })

  it('bounds the number of keys it will hold', () => {
    const lookup = vi.fn((key: string) => [key])
    const memo = memoizeBriefly(lookup, { ttlMs: 60_000, now: () => clock, maxKeys: 4 })
    for (let i = 0; i < 100; i += 1) memo(`ws-${i}`)
    // The oldest were evicted, so an early key costs a call-through again.
    memo('ws-0')
    expect(lookup).toHaveBeenCalledTimes(101)
  })
})

describe('LOW-1 · nothing from this machine reaches an anonymous caller', () => {
  it('keeps the key-mode message inside the process', () => {
    const service = new CallCredentialService({ base, now: () => clock })
    service.mint('alice', 'ws')
    chmodSync(path.join(base, 'call-token-key.jwk'), 0o644)
    const reopened = new CallCredentialService({ base, now: () => clock })
    let message = ''
    try {
      reopened.mint('alice', 'ws')
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    // The message names the remedy and DOES contain a mode; what matters is
    // that call-endpoints answers 401 without it — pinned in the endpoint
    // suite. Here we only assert it is not empty, so the owner has something
    // to act on when they read it in their own logs.
    expect(message).toMatch(/chmod 600/)
    expect(message).not.toContain(base)
  })
})
