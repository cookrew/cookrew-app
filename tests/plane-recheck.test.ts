import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { helloMessageV2 } from '../src/shared/hello-proof'
import {
  RECHECK_EVERY_MS,
  recheckPlane,
  startPlaneRecheck,
  type PlaneRecheckDeps,
  type RecheckOutcome
} from '../src/renderer/src/path/plane-recheck'
import { createPlaneHealth } from '../src/renderer/src/plane-health'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { HelloReply } from '../src/renderer/src/path/switch'

/**
 * A PLANE PROVES ITSELF AGAIN, OR IT LOSES THE SESSION.
 *
 * The switcher's proof is a snapshot: a name answered as the Mac once. DNS
 * rebinding is the whole reason the Local Network Access specification demands
 * the check on every new connection — the second answer to a lookup does not
 * have to be the first one, and every request after it carries the pairing
 * token to wherever the name now points.
 *
 * Two failures, deliberately handled differently: an answer that is not the
 * Mac's condemns the plane at once, and no answer at all is left to the
 * transport counter that already exists.
 */

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ORIGIN = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`
const OTHER = `https://10-0-0-9.${DEVICE}.d.cookrew.dev:8643`
const LAN: DataPlane = { origin: ORIGIN, kind: 'lan' }
const RELAY: DataPlane = { origin: '', kind: 'relay' }
const NOW = 1_800_000_000_000
const NONCE = 'n'.repeat(24)

/** Let the in-flight re-check finish, so the one-at-a-time latch reopens. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const mac = generateKeyPairSync('ed25519')

const answer = (nonce: string, origin = ORIGIN): HelloReply => ({
  v: 2,
  deviceId: DEVICE,
  origin,
  issuedAtMs: NOW,
  nonce,
  sig: sign(
    null,
    Buffer.from(helloMessageV2(DEVICE, origin, NOW, nonce), 'utf8'),
    mac.privateKey
  ).toString('base64url')
})

interface Run {
  readonly outcome: RecheckOutcome
  readonly noted: readonly boolean[]
  readonly condemned: number
  readonly asked: readonly string[]
  readonly verified: number
}

const check = async (over: Partial<PlaneRecheckDeps> = {}): Promise<Run> => {
  const noted: boolean[] = []
  const asked: string[] = []
  let condemned = 0
  let verified = 0
  const outcome = await recheckPlane({
    plane: over.plane ?? ((): DataPlane => LAN),
    deviceId: over.deviceId ?? ((): string | null => DEVICE),
    hello:
      over.hello ??
      (async (origin, nonce) => {
        asked.push(origin)
        return answer(nonce)
      }),
    verify:
      over.verify ??
      (async () => {
        verified += 1
        return true
      }),
    nonce: over.nonce ?? ((): string => NONCE),
    health: over.health ?? {
      note: (ok) => void noted.push(ok),
      condemn: () => void (condemned += 1)
    },
    ...(over.log ? { log: over.log } : {})
  })
  return { outcome, noted, condemned, asked, verified }
}

describe('one re-check', () => {
  it('asks the plane it is on, once, and keeps it when it still proves out', async () => {
    const run = await check()
    expect(run.outcome).toBe('proved')
    expect(run.asked).toEqual([ORIGIN])
    expect(run.verified).toBe(1)
    expect(run.condemned).toBe(0)
  })

  it('does nothing on the relay — the page came over it', async () => {
    const run = await check({ plane: () => RELAY })
    expect(run.outcome).toBe('skipped')
    expect(run.asked).toEqual([])
  })

  it('does nothing when the desktop it belongs to was never learned', async () => {
    const run = await check({ deviceId: () => null })
    expect(run.outcome).toBe('skipped')
    expect(run.asked).toEqual([])
  })

  it('CONDEMNS a plane whose answer names a different origin', async () => {
    // The rebinding case: the name now resolves somewhere else, and that
    // somewhere else relays our challenge to the real Mac. The signature is
    // real; the origin in it is not the one this plane is dialling.
    const run = await check({ hello: async (_origin, nonce) => answer(nonce, OTHER) })
    expect(run.outcome).toBe('unproven')
    expect(run.condemned).toBe(1)
    // Not sent to the registry: it would have said yes.
    expect(run.verified).toBe(0)
  })

  it('condemns a plane answering as another device, or with version 1', async () => {
    const stranger = await check({
      hello: async (_o, nonce) => ({ ...answer(nonce), deviceId: 'somebody-else' })
    })
    expect(stranger.condemned).toBe(1)
    const old = await check({
      hello: async (_o, nonce) => ({ deviceId: DEVICE, nonce, sig: 'x' })
    })
    expect(old.condemned).toBe(1)
  })

  it('condemns a plane the registry no longer vouches for', async () => {
    const run = await check({ verify: async () => false })
    expect(run.outcome).toBe('unproven')
    expect(run.condemned).toBe(1)
  })

  it("does NOT condemn on silence — that is the transport counter's business", async () => {
    const run = await check({ hello: async () => null })
    expect(run.outcome).toBe('unreachable')
    expect(run.condemned).toBe(0)
    // Fed to the same counter every other failed request goes to.
    expect(run.noted).toEqual([false])
  })

  it('does not condemn when the REGISTRY cannot be reached', async () => {
    // Offline, rate limited, signed out. None of that is a verdict about the
    // plane, and dropping a working LAN session for it would be a regression.
    const run = await check({ verify: () => Promise.reject(new Error('offline')) })
    expect(run.outcome).toBe('unreachable')
    expect(run.condemned).toBe(0)
  })

  it('survives a hello that throws rather than answers', async () => {
    const run = await check({ hello: () => Promise.reject(new Error('gone')) })
    expect(run.outcome).toBe('unreachable')
    expect(run.condemned).toBe(0)
  })
})

describe('the fallback a condemnation causes', () => {
  it('drops to the relay and holds, through the existing plane-health path', () => {
    let direct = true
    let fellBack = 0
    let clock = 0
    const health = createPlaneHealth({
      now: () => clock,
      direct: () => direct,
      fallBack: () => {
        direct = false
        fellBack += 1
      }
    })
    health.condemn()
    expect(fellBack).toBe(1)
    // And the switcher is held off, so the same name cannot be re-adopted on
    // the next tick — which is what made the badge flap before the hold.
    expect(health.held()).toBe(true)
    clock += 59_000
    expect(health.held()).toBe(true)
    clock += 2_000
    expect(health.held()).toBe(false)
  })

  it('is a no-op on the relay, where there is nothing to fall back from', () => {
    let fellBack = 0
    const health = createPlaneHealth({ direct: () => false, fallBack: () => void (fellBack += 1) })
    health.condemn()
    expect(fellBack).toBe(0)
  })
})

describe('the schedule', () => {
  it('is five minutes, and also whenever the phone comes back online', async () => {
    expect(RECHECK_EVERY_MS).toBe(300_000)
    const listeners: Record<string, () => void> = {}
    let tick: (() => void) | null = null
    let asked = 0
    const recheck = startPlaneRecheck({
      deps: {
        plane: () => LAN,
        deviceId: () => DEVICE,
        hello: async (_o, nonce) => {
          asked += 1
          return answer(nonce)
        },
        verify: async () => true,
        nonce: () => NONCE,
        health: { note: () => undefined, condemn: () => undefined }
      },
      setInterval: (fn, ms) => {
        expect(ms).toBe(RECHECK_EVERY_MS)
        tick = fn
        return () => void (tick = null)
      },
      on: (event, listener) => {
        listeners[event] = listener
        return () => void delete listeners[event]
      }
    })
    // Nothing at construction: the plane has just proved itself.
    expect(asked).toBe(0)
    tick?.()
    await settle()
    listeners.online?.()
    await settle()
    // And the caller's own moment — a push stream that came back.
    recheck.now()
    await settle()
    expect(asked).toBe(3)
    recheck.stop()
    expect(Object.keys(listeners)).toEqual([])
  })

  it('runs one at a time, however many moments land together', async () => {
    let asked = 0
    let release: (() => void) | null = null
    const recheck = startPlaneRecheck({
      deps: {
        plane: () => LAN,
        deviceId: () => DEVICE,
        hello: async (_o, nonce) => {
          asked += 1
          await new Promise<void>((resolve) => void (release = resolve))
          return answer(nonce)
        },
        verify: async () => true,
        nonce: () => NONCE,
        health: { note: () => undefined, condemn: () => undefined }
      },
      setInterval: () => () => undefined,
      on: () => () => undefined
    })
    recheck.now()
    recheck.now()
    recheck.now()
    expect(asked).toBe(1)
    release?.()
    recheck.stop()
  })
})
