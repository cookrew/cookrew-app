import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WATCH_CODE_GUESSES,
  WATCH_CODE_TTL_MS,
  WATCH_FAILS_BEFORE_PAUSE,
  WATCH_PAUSE_MS,
  WatchPairing
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
