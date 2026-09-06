import { describe, expect, it } from 'vitest'
import {
  PATH_MEMORY_PREFIX,
  betterCandidates,
  pathRank,
  randomNonce,
  startPathSwitching,
  switchIfBetter,
  type ReachCardLite,
  type SwitchDeps,
  type SwitchOutcome
} from '../src/renderer/src/path/switch'

/**
 * IDENTITY v2, PHASE 3 — THE COMPANION MOVING ITSELF ONTO THE NEARER PATH.
 *
 * "When the phone joins the LAN the session switches live and the badge flips
 * to ● LAN; nothing to confirm." What is tested here is every way that can go
 * wrong quietly: switching sideways, switching onto whatever answered, and
 * switching without the credential — all three leave a phone worse off than
 * the slow path it was on, and none of them would raise an error.
 */

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = 'https://192.168.1.24:8643'
const LAN2 = 'https://10.0.0.9:8643'
const TAILNET = 'https://100.68.81.64:8643'

const card = (over: Partial<ReachCardLite> = {}): ReachCardLite => ({
  deviceId: DEVICE,
  lan: [{ url: LAN }],
  tailnet: { url: TAILNET },
  ...over
})

interface Run {
  readonly outcome: () => SwitchOutcome
  readonly went: () => string | null
  readonly asked: () => readonly string[]
  readonly probes: () => readonly boolean[]
  readonly remembered: () => Record<string, string>
}

/** One race, with everything the browser would have supplied stood in for. */
const race = async (
  over: Partial<SwitchDeps> & { readonly answers?: Record<string, string> } = {}
): Promise<Run> => {
  const asked: string[] = []
  const probes: boolean[] = []
  const memory: Record<string, string> = {}
  let went: string | null = null
  let nonces = 0
  const answers = over.answers ?? { [LAN]: DEVICE, [TAILNET]: DEVICE }

  const deps: SwitchDeps = {
    current: over.current ?? ((): 'RELAY' => 'RELAY'),
    card: over.card ?? (async () => card()),
    hello:
      over.hello ??
      (async (url, nonce) => {
        asked.push(url)
        const who = answers[url]
        return who === undefined ? null : { deviceId: who, nonce }
      }),
    credential: over.credential ?? ((): string => 'the-pairing-token'),
    go: over.go ?? ((url) => void (went = url)),
    nonce: over.nonce ?? ((): string => `nonce-${(nonces += 1)}`),
    remembered: over.remembered ?? ((deviceId) => memory[`${PATH_MEMORY_PREFIX}${deviceId}`] ?? null),
    remember:
      over.remember ?? ((deviceId, url) => void (memory[`${PATH_MEMORY_PREFIX}${deviceId}`] = url)),
    probing: over.probing ?? ((on) => void probes.push(on))
  }
  const outcome = await switchIfBetter(deps)
  return {
    outcome: () => outcome,
    went: () => went,
    asked: () => asked,
    probes: () => probes,
    remembered: () => memory
  }
}

describe('the order of the paths', () => {
  it('is LAN, then tailnet, then relay', () => {
    expect(pathRank('LAN')).toBeGreaterThan(pathRank('TAILNET'))
    expect(pathRank('TAILNET')).toBeGreaterThan(pathRank('RELAY'))
    // A state that is not a path at all is worse than every path.
    expect(pathRank('OFFLINE')).toBe(0)
    expect(pathRank('PROBING')).toBe(0)
  })

  it('offers only what beats where the phone already is', () => {
    expect(betterCandidates(card(), 'RELAY')).toEqual([
      { url: LAN, state: 'LAN' },
      { url: TAILNET, state: 'TAILNET' }
    ])
    // On the tailnet the tailnet is not an improvement — offering it would be
    // a page reload that changes nothing, every thirty seconds, forever.
    expect(betterCandidates(card(), 'TAILNET')).toEqual([{ url: LAN, state: 'LAN' }])
    expect(betterCandidates(card(), 'LAN')).toEqual([])
  })

  it('puts the address that worked last time first, without trusting it', () => {
    const two = card({ lan: [{ url: LAN }, { url: LAN2 }] })
    expect(betterCandidates(two, 'RELAY', LAN2)).toEqual([
      { url: LAN2, state: 'LAN' },
      { url: LAN, state: 'LAN' },
      { url: TAILNET, state: 'TAILNET' }
    ])
  })
})

describe('one race', () => {
  it('switches to the LAN carrying the credential the phone already holds', async () => {
    const run = await race()
    expect(run.outcome()).toBe('switched')
    expect(run.went()).toBe(`${LAN}/?token=the-pairing-token`)
    // The LAN answered, so nothing else was even asked.
    expect(run.asked()).toEqual([LAN])
    expect(run.remembered()).toEqual({ [`${PATH_MEMORY_PREFIX}${DEVICE}`]: LAN })
  })

  it('says PROBING while it looks, and stops saying it when it is done', async () => {
    const run = await race({ answers: {} })
    expect(run.outcome()).toBe('unreachable')
    expect(run.probes()).toEqual([true, false])
  })

  it('does nothing at all from the LAN — there is nothing better', async () => {
    const run = await race({ current: () => 'LAN' })
    expect(run.outcome()).toBe('skipped')
    expect(run.asked()).toEqual([])
    // Not even the card is fetched: a probe from the best path is 120 pointless
    // requests an hour off a phone battery.
    expect(run.probes()).toEqual([])
  })

  it('falls back to the tailnet when the LAN does not answer', async () => {
    const run = await race({ answers: { [TAILNET]: DEVICE } })
    expect(run.outcome()).toBe('switched')
    expect(run.asked()).toEqual([LAN, TAILNET])
    expect(run.went()).toBe(`${TAILNET}/?token=the-pairing-token`)
  })

  it('refuses an address that answers as somebody else', async () => {
    // Something else on this Wi-Fi is listening on 8643. It answers, and it is
    // not the Mac — which is the entire reason hello exists.
    const run = await race({ answers: { [LAN]: 'a-different-mac', [TAILNET]: DEVICE } })
    expect(run.outcome()).toBe('switched')
    expect(run.went()).toBe(`${TAILNET}/?token=the-pairing-token`)
  })

  it('refuses a replayed answer, however right the device id is', async () => {
    const run = await race({
      hello: async (url) => (url === LAN ? { deviceId: DEVICE, nonce: 'a-nonce-from-yesterday' } : null)
    })
    expect(run.outcome()).toBe('unreachable')
    expect(run.went()).toBe(null)
  })

  it('stays where it is when nothing answers', async () => {
    const run = await race({ answers: {} })
    expect(run.outcome()).toBe('unreachable')
    expect(run.went()).toBe(null)
    expect(run.remembered()).toEqual({})
  })

  it('stays where it is when the desktop cannot be asked', async () => {
    const run = await race({ card: async () => null })
    expect(run.outcome()).toBe('no-card')
    expect(run.asked()).toEqual([])
  })

  it('survives a desktop that throws rather than answers', async () => {
    const run = await race({
      card: () => Promise.reject(new Error('the link went down mid-probe'))
    })
    expect(run.outcome()).toBe('no-card')
  })

  it('does not switch a phone that would land unpaired', async () => {
    const run = await race({ credential: () => null })
    expect(run.outcome()).toBe('no-credential')
    expect(run.went()).toBe(null)
  })

  it('stays put when the card offers nothing better', async () => {
    const run = await race({ current: () => 'TAILNET', card: async () => card({ lan: [] }) })
    expect(run.outcome()).toBe('no-better')
    expect(run.asked()).toEqual([])
  })

  it('leaves the relay prefix behind when it leaves the relay', async () => {
    // Under the relay the page lives at /relay/@user/desktop/<id>/ and every
    // request it makes carries that prefix. The LAN address is a DIFFERENT
    // ORIGIN serving the app at its own root — carrying the prefix across
    // would land the phone on a 404 with no way back.
    const run = await race()
    expect(run.went()).toBe(`${LAN}/?token=the-pairing-token`)
    expect(run.went()).not.toContain('/relay/')
  })

  it('escapes a credential that needs it', async () => {
    const run = await race({ credential: () => 'a b/c' })
    expect(run.went()).toBe(`${LAN}/?token=a%20b%2Fc`)
  })
})

describe('the loop', () => {
  it('races at boot, on a timer, and when the network might have changed', async () => {
    const events = new Map<string, () => void>()
    let tick: (() => void) | null = null
    let races = 0
    const stop = startPathSwitching({
      deps: {
        current: () => 'RELAY',
        card: async () => {
          races += 1
          return null
        },
        hello: async () => null,
        credential: () => 't',
        go: () => undefined,
        nonce: () => 'n'
      },
      setInterval: (fn) => {
        tick = fn
        return () => void (tick = null)
      },
      on: (event, listener) => {
        events.set(event, listener)
        return () => void events.delete(event)
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(races).toBe(1)

    // Each is awaited, because a race already in flight swallows the next
    // trigger by design — that is the subject of the test below.
    for (const wake of [tick, events.get('online'), events.get('visibilitychange')]) {
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(races).toBe(4)

    stop()
    expect(events.size).toBe(0)
    expect(tick).toBe(null)
  })

  it('runs one race at a time, however many things wake it at once', async () => {
    const events = new Map<string, () => void>()
    let races = 0
    const gate: { release: (() => void) | null } = { release: null }
    startPathSwitching({
      deps: {
        current: () => 'RELAY',
        card: () =>
          new Promise((resolve) => {
            races += 1
            gate.release = () => resolve(null)
          }),
        hello: async () => null,
        credential: () => 't',
        go: () => undefined,
        nonce: () => 'n'
      },
      setInterval: () => () => undefined,
      on: (event, listener) => {
        events.set(event, listener)
        return () => events.delete(event)
      }
    })
    // A phone waking on a new network fires all three at once; three
    // simultaneous races would triple the probes and could navigate twice.
    events.get('online')?.()
    events.get('visibilitychange')?.()
    expect(races).toBe(1)
    gate.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    events.get('online')?.()
    expect(races).toBe(2)
  })
})

describe('the nonce', () => {
  it('is 16 bytes of base64url, which is what /api/hello accepts', () => {
    const nonce = randomNonce((bytes) => bytes.map((_, index) => index * 7))
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(nonce, 'base64url').byteLength).toBe(16)
  })
})
