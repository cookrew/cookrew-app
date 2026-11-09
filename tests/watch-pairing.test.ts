import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  WATCH_CODE_GUESSES,
  WATCH_CODE_TTL_MS,
  WATCH_FAILS_BEFORE_PAUSE,
  WATCH_PAUSE_MS,
  WatchPairing,
  watchProof
} from '../src/main/watch-pairing'

const fresh = (start = 1000): { pairing: WatchPairing; file: string; clock: { now: number } } => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'watch-pair-')), 'watch-token')
  const clock = { now: start }
  return { pairing: new WatchPairing({ file, now: () => clock.now }), file, clock }
}
const wrong = (code: string): string => (code === '000000' ? '000001' : '000000')

describe('a watch pairs with six digits', () => {
  it('a code gives a token once, kept 0600, and the token opens only while it stands', () => {
    const { pairing, file } = fresh()
    expect(pairing.paired).toBe(false)
    const { code } = pairing.mintCode()
    expect(code).toMatch(/^\d{6}$/)
    const claim = pairing.claim(code)
    if (!claim.ok) throw new Error('claim failed')
    expect(pairing.accepts(claim.token)).toBe(true)
    expect(pairing.accepts(`${claim.token}x`)).toBe(false)
    expect(pairing.accepts(null)).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').trim()).toBe(claim.token)
    expect(pairing.claim(code)).toEqual({ ok: false, reason: 'no-code' })
    pairing.unpair()
    expect(pairing.accepts(claim.token)).toBe(false)
  })

  it('survives a restart of the app', () => {
    const { pairing, file } = fresh()
    const claim = pairing.claim(pairing.mintCode().code)
    if (!claim.ok) throw new Error('claim failed')
    expect(new WatchPairing({ file }).accepts(claim.token)).toBe(true)
  })

  it('a new claim replaces the old watch', () => {
    const { pairing } = fresh()
    const first = pairing.claim(pairing.mintCode().code)
    const second = pairing.claim(pairing.mintCode().code)
    if (!first.ok || !second.ok) throw new Error('claim failed')
    expect(pairing.accepts(first.token)).toBe(false)
    expect(pairing.accepts(second.token)).toBe(true)
  })

  it('a code ends after five minutes', () => {
    const { pairing, clock } = fresh()
    const { code } = pairing.mintCode()
    expect(pairing.pending()).not.toBeNull()
    clock.now += WATCH_CODE_TTL_MS
    expect(pairing.pending()).toBeNull()
    expect(pairing.claim(code)).toEqual({ ok: false, reason: 'expired' })
  })

  it('five wrong guesses burn the code, the right one included', () => {
    const { pairing } = fresh()
    const { code } = pairing.mintCode()
    for (let i = 1; i < WATCH_CODE_GUESSES; i += 1) expect(pairing.claim(wrong(code))).toEqual({ ok: false, reason: 'wrong' })
    expect(pairing.claim(wrong(code))).toEqual({ ok: false, reason: 'burned' })
    expect(pairing.claim(code)).toEqual({ ok: false, reason: 'no-code' })
  })

  it('anything but a string of digits is a wrong guess, not a crash', () => {
    const { pairing } = fresh()
    pairing.mintCode()
    for (const junk of [123456, null, {}, '']) expect(pairing.claim(junk)).toEqual({ ok: false, reason: 'wrong' })
  })

  it('failed claims from anyone pause claiming for everyone', () => {
    const { pairing, clock } = fresh()
    for (let i = 0; i < WATCH_FAILS_BEFORE_PAUSE; i += 1) pairing.claim('000000')
    const { code } = pairing.mintCode()
    expect(pairing.claim(code)).toEqual({ ok: false, reason: 'paused' })
    clock.now += WATCH_PAUSE_MS
    expect(pairing.claim(code).ok).toBe(true)
  })
})

describe('a join code doubles as the claim', () => {
  const later = (clock: { now: number }): number => clock.now + 10 * 60 * 1000

  it('claims with the code the account minted, however it is typed', () => {
    const { pairing, clock } = fresh()
    pairing.arm('K7QM-2XPD', later(clock))
    const claim = pairing.claim('k7qm 2xpd')
    if (!claim.ok) throw new Error('claim failed')
    expect(pairing.accepts(claim.token)).toBe(true)
    expect(pairing.claim('K7QM2XPD')).toEqual({ ok: false, reason: 'no-code' })
  })

  it('lasts as long as the registry said, not the six digits\' five minutes', () => {
    const { pairing, clock } = fresh()
    const expiresAt = later(clock)
    pairing.arm('K7QM-2XPD', expiresAt)
    clock.now += WATCH_CODE_TTL_MS
    expect(pairing.pending()).toEqual({ expiresAt })
    clock.now = expiresAt
    expect(pairing.claim('K7QM-2XPD')).toEqual({ ok: false, reason: 'expired' })
  })

  it('replaces six digits on offer, and six digits replace it', () => {
    const { pairing, clock } = fresh()
    const { code } = pairing.mintCode()
    pairing.arm('K7QM-2XPD', later(clock))
    expect(pairing.claim(code)).toEqual({ ok: false, reason: 'wrong' })
    const next = pairing.mintCode()
    expect(pairing.claim('K7QM-2XPD')).toEqual({ ok: false, reason: 'wrong' })
    expect(pairing.claim(next.code).ok).toBe(true)
  })

  it('five wrong guesses burn it too', () => {
    const { pairing, clock } = fresh()
    pairing.arm('K7QM-2XPD', later(clock))
    for (let i = 1; i < WATCH_CODE_GUESSES; i += 1) pairing.claim('AAAA-AAAA')
    expect(pairing.claim('AAAA-AAAA')).toEqual({ ok: false, reason: 'burned' })
    expect(pairing.claim('K7QM-2XPD')).toEqual({ ok: false, reason: 'no-code' })
  })
})

describe('a Mac proves it holds the token without sending it', () => {
  it('signs a nonce with the token, as the wrist checks it', () => {
    const { pairing } = fresh()
    const claim = pairing.claim(pairing.mintCode().code)
    if (!claim.ok) throw new Error('claim failed')
    const expected = createHmac('sha256', claim.token).update('cookrew-watch-hello/1 nonce-0123456789abcdef').digest('base64url')
    expect(pairing.proof('nonce-0123456789abcdef')).toBe(expected)
  })

  it('matches the vector the Swift side is tested against', () => {
    expect(watchProof('mac-token', 'nonce-0123456789abcdef')).toBe('cBtQe4csbmPvxeVVg4OJ0NkU0FBGhTBQIZcCGH5GFX8')
  })

  it('has nothing to prove with no watch paired', () => {
    expect(fresh().pairing.proof('nonce-0123456789abcdef')).toBeNull()
  })
})

describe('how the sheet knows a watch arrived', () => {
  it('counts claims, so a code that merely went away is not an arrival', () => {
    const { pairing } = fresh()
    expect(pairing.claims).toBe(0)
    const { code } = pairing.mintCode()
    for (let i = 0; i < WATCH_CODE_GUESSES; i += 1) pairing.claim('000')
    expect(pairing.claims).toBe(0)
    expect(pairing.claim(pairing.mintCode().code).ok).toBe(true)
    expect(pairing.claims).toBe(1)
    expect(code).toMatch(/^\d{6}$/)
  })
})

describe('a watch let in by its account pass', () => {
  it('gets a token of its own, with no code, and the token is what opens the routes', () => {
    const pairing = new WatchPairing({ file: path.join(mkdtempSync(path.join(tmpdir(), 'watch-enter-')), 'watch-token') })
    const token = pairing.enter('cccc-watch')
    expect(token).toMatch(/^[A-Za-z0-9_-]{24,}$/)
    expect(pairing.paired).toBe(true)
    expect(pairing.accepts(token)).toBe(true)
    expect(pairing.claims).toBe(1)
  })
})

describe('a watch the account revoked', () => {
  it('loses this machine with it: its token stops, and a watch paired by digits is left alone', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watch-revoked-'))
    const pairing = new WatchPairing({ file: path.join(dir, 'watch-token') })
    const token = pairing.enter('aaaa-watch')
    expect(pairing.revoked(['someone-else'])).toBe(false)
    expect(pairing.accepts(token)).toBe(true)
    expect(pairing.revoked(['aaaa-watch'])).toBe(true)
    expect(pairing.accepts(token)).toBe(false)
    // It is remembered across a restart, so a revocation later still finds it.
    const again = new WatchPairing({ file: path.join(dir, 'watch-token') })
    const second = again.enter('bbbb-watch')
    expect(new WatchPairing({ file: path.join(dir, 'watch-token') }).revoked(['bbbb-watch'])).toBe(true)
    expect(second.length).toBeGreaterThan(16)
  })
})

describe('a watch that claimed its first machine down the relay', () => {
  it('is known there by its account device, so revoking it ends that token too', () => {
    const pairing = new WatchPairing({ file: path.join(mkdtempSync(path.join(tmpdir(), 'watch-claim-')), 'watch-token') })
    const { code } = pairing.mintCode()
    const claim = pairing.claim(code, 'dddd-watch')
    if (!claim.ok) throw new Error('claim failed')
    expect(pairing.revoked(['dddd-watch'])).toBe(true)
    expect(pairing.accepts(claim.token)).toBe(false)
  })
})
