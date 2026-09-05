// THE IDLE LOCK — what it covers, and what it deliberately does not.
//
// The clock is injected, so fifteen minutes of idleness is a number in a test
// rather than a wait. Nothing here touches a real home directory or a socket.

import { describe, expect, it } from 'vitest'
import { IdleLock, MAX_TRIES, PAUSE_MS } from '../src/main/lock'
import { DEFAULT_LOCK_AFTER_MS } from '../src/main/account-v2'

const PASSWORD = 'correct-horse-battery'

/** A lock over a clock the test moves by hand. */
function locked(lockAfterMs = DEFAULT_LOCK_AFTER_MS): {
  lock: IdleLock
  at: (ms: number) => void
  changes: boolean[]
} {
  let clock = 0
  const changes: boolean[] = []
  const lock = new IdleLock({
    lockAfterMs,
    verify: (password) => password === PASSWORD,
    now: () => clock,
    onChange: (value) => changes.push(value),
  })
  return { lock, changes, at: (ms) => void (clock = ms) }
}

describe('idle → locked, at fifteen minutes by default', () => {
  it('stays unlocked until the setting has passed', () => {
    const { lock, at } = locked()
    at(DEFAULT_LOCK_AFTER_MS - 1)
    expect(lock.tick()).toBe(false)
    at(DEFAULT_LOCK_AFTER_MS)
    expect(lock.tick()).toBe(true)
    expect(lock.locked).toBe(true)
  })

  it('activity pushes the deadline out', () => {
    const { lock, at } = locked()
    at(600_000)
    lock.activity()
    at(DEFAULT_LOCK_AFTER_MS + 100)
    expect(lock.tick()).toBe(false)
    at(600_000 + DEFAULT_LOCK_AFTER_MS)
    expect(lock.tick()).toBe(true)
  })

  it('window focus counts as presence', () => {
    const { lock, at } = locked()
    at(500_000)
    lock.focus()
    at(DEFAULT_LOCK_AFTER_MS + 100)
    expect(lock.tick()).toBe(false)
  })

  it('IGNORES activity while locked', () => {
    // The lock screen is a live React tree that types and clicks. An activity
    // ping from it would push the deadline out and the app would unlock itself
    // by being looked at.
    const { lock, at } = locked()
    at(DEFAULT_LOCK_AFTER_MS)
    lock.tick()
    at(DEFAULT_LOCK_AFTER_MS + 5_000)
    lock.activity()
    expect(lock.locked).toBe(true)
  })

  it('announces each change once, never on every tick', () => {
    const { lock, at, changes } = locked()
    at(DEFAULT_LOCK_AFTER_MS)
    lock.tick()
    lock.tick()
    lock.tick()
    expect(changes).toEqual([true])
  })
})

describe('off means off', () => {
  it('never locks when the setting is 0', () => {
    const { lock, at } = locked(0)
    at(86_400_000)
    expect(lock.tick()).toBe(false)
  })

  it('turning it off unlocks — a locked screen behind an OFF switch is a lie', () => {
    const { lock, at } = locked()
    at(DEFAULT_LOCK_AFTER_MS)
    lock.tick()
    expect(lock.locked).toBe(true)
    expect(lock.setLockAfterMs(0)).toBe(0)
    expect(lock.locked).toBe(false)
  })

  it('turning it on restarts the idle clock rather than locking at once', () => {
    const { lock, at } = locked(0)
    at(86_400_000)
    lock.setLockAfterMs(60_000)
    expect(lock.tick()).toBe(false)
    at(86_460_000)
    expect(lock.tick()).toBe(true)
  })

  it('treats a negative or absurd setting as off', () => {
    const { lock } = locked()
    expect(lock.setLockAfterMs(-1)).toBe(0)
    expect(lock.setLockAfterMs(Number.NaN)).toBe(0)
  })
})

describe('unlock, offline', () => {
  it('opens on the password and clears the idle clock', () => {
    const { lock, at } = locked()
    at(DEFAULT_LOCK_AFTER_MS)
    lock.tick()
    expect(lock.unlock(PASSWORD)).toEqual({ ok: true })
    expect(lock.locked).toBe(false)
    at(DEFAULT_LOCK_AFTER_MS + 100)
    expect(lock.tick()).toBe(false)
  })

  it('counts wrong tries down, in the sentence the screen shows', () => {
    const { lock } = locked()
    lock.lock()
    expect(lock.unlock('nope')).toEqual({ ok: false, reason: 'wrong', triesLeft: MAX_TRIES - 1 })
    expect(lock.unlock('nope')).toEqual({ ok: false, reason: 'wrong', triesLeft: MAX_TRIES - 2 })
  })

  it('pauses for a minute after five wrong, then takes the password again', () => {
    const { lock, at } = locked()
    lock.lock()
    for (let n = 0; n < MAX_TRIES - 1; n += 1) lock.unlock('nope')
    expect(lock.unlock('nope')).toEqual({ ok: false, reason: 'paused', pausedForMs: PAUSE_MS })
    // Even the RIGHT password waits out the pause — otherwise the pause is
    // only a pause for someone who does not know the password is close.
    expect(lock.unlock(PASSWORD)).toMatchObject({ ok: false, reason: 'paused' })
    at(PAUSE_MS + 1)
    expect(lock.unlock(PASSWORD)).toEqual({ ok: true })
  })

  it('a right answer clears the count — the counter slows a guesser, not a typo', () => {
    const { lock } = locked()
    lock.lock()
    lock.unlock('nope')
    lock.unlock('nope')
    lock.unlock(PASSWORD)
    lock.lock()
    expect(lock.unlock('nope')).toEqual({ ok: false, reason: 'wrong', triesLeft: MAX_TRIES - 1 })
  })

  it('refuses everything when there is no account to verify against', () => {
    const lock = new IdleLock({ lockAfterMs: 0, verify: () => false })
    lock.lock()
    expect(lock.unlock('anything at all')).toMatchObject({ ok: false, reason: 'wrong' })
    expect(lock.locked).toBe(true)
  })
})
