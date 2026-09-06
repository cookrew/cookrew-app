// WHEN TO GIVE UP ON THE FAST PLANE.
//
// A direct plane is an optimisation and it dies without announcing anything:
// the phone leaves the house, the Wi-Fi drops, the Mac sleeps. The relay is
// still there and still works, but every request is now going to an address
// that no longer answers and nothing on screen says so — a dead app that looks
// alive, which is the exact failure auth-gate.ts was written to end for the
// credential.
//
// So the rules are pinned here rather than discovered on a phone: what counts
// as a failure (only a transport failure, never an answer), how long a dropped
// stream has to heal itself, and why falling back is followed by a HOLD rather
// than an immediate re-race.

import { describe, expect, it } from 'vitest'
import {
  DIRECT_FAILURE_LIMIT,
  HOLD_AFTER_FALLBACK_MS,
  STREAM_GRACE_MS,
  createPlaneHealth
} from '../src/renderer/src/plane-health'

interface Rig {
  readonly health: ReturnType<typeof createPlaneHealth>
  readonly fell: () => number
  readonly tick: (ms: number) => void
  /** Run whatever timer is armed, as if its deadline had passed. */
  readonly fire: () => void
  readonly armed: () => boolean
  readonly goRelay: () => void
}

const rig = (direct = true): Rig => {
  let now = 1_000_000
  let fell = 0
  let onDirect = direct
  let pending: (() => void) | null = null
  const health = createPlaneHealth({
    now: () => now,
    schedule: (run) => {
      pending = run
      return 'timer'
    },
    cancel: () => void (pending = null),
    direct: () => onDirect,
    fallBack: () => {
      fell += 1
      onDirect = false
    }
  })
  return {
    health,
    fell: () => fell,
    tick: (ms) => void (now += ms),
    fire: () => {
      const run = pending
      pending = null
      run?.()
    },
    armed: () => pending !== null,
    goRelay: () => void (onDirect = false)
  }
}

describe('consecutive request failures', () => {
  it('gives up after the limit, and not before', () => {
    const r = rig()
    for (let i = 0; i < DIRECT_FAILURE_LIMIT - 1; i += 1) r.health.note(false)
    expect(r.fell()).toBe(0)
    r.health.note(false)
    expect(r.fell()).toBe(1)
  })

  it('forgives a hiccup — one success clears the run', () => {
    // A single failed request on a busy Wi-Fi is not a dead path, and reading
    // it as one would drop a working phone back onto the relay all day.
    const r = rig()
    r.health.note(false)
    r.health.note(false)
    r.health.note(true)
    r.health.note(false)
    r.health.note(false)
    expect(r.fell()).toBe(0)
  })

  it('never blames the plane for an ANSWER', () => {
    // Only a thrown fetch is reported as a failure; a 401 or a 500 arrives as
    // note(true), because receiving it proves the plane carried the request.
    const r = rig()
    for (let i = 0; i < DIRECT_FAILURE_LIMIT * 3; i += 1) r.health.note(true)
    expect(r.fell()).toBe(0)
  })

  it('counts nothing at all while the phone is already on the relay', () => {
    const r = rig(false)
    for (let i = 0; i < DIRECT_FAILURE_LIMIT * 2; i += 1) r.health.note(false)
    expect(r.fell()).toBe(0)
  })
})

describe('the push channel', () => {
  it('gives the stream a grace window before blaming the plane', () => {
    // EventSource reconnects for a living. A drop is only evidence when it
    // has not healed itself.
    const r = rig()
    r.health.link('reconnecting')
    expect(r.fell()).toBe(0)
    r.health.link('live')
    r.fire()
    expect(r.fell()).toBe(0)
  })

  it('falls back when the window passes with the stream still down', () => {
    const r = rig()
    r.health.link('failed')
    r.tick(STREAM_GRACE_MS)
    r.fire()
    expect(r.fell()).toBe(1)
  })

  it('arms the window once per outage, not once per retry', () => {
    // A stream backing off through five attempts must not keep resetting its
    // own deadline — that is an outage that is never five seconds old.
    const r = rig()
    r.health.link('reconnecting')
    r.health.link('reconnecting')
    r.health.link('failed')
    expect(r.armed()).toBe(true)
    r.fire()
    expect(r.fell()).toBe(1)
    // And the fallback disarmed it rather than leaving a timer behind.
    expect(r.armed()).toBe(false)
  })
})

describe('the hold after a fallback', () => {
  it('keeps the switcher off the plane it just left, then lets it try again', () => {
    const r = rig()
    r.health.link('failed')
    r.tick(STREAM_GRACE_MS)
    r.fire()
    expect(r.health.held()).toBe(true)

    r.tick(HOLD_AFTER_FALLBACK_MS - 1)
    expect(r.health.held()).toBe(true)

    // A minute later the phone may well be back in the house, and re-racing
    // is how the badge flips to LAN again without anybody tapping anything.
    r.tick(2)
    expect(r.health.held()).toBe(false)
  })

  it('holds nothing until something has actually failed', () => {
    expect(rig().health.held()).toBe(false)
  })
})
