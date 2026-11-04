import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SEND_TRIES,
  createTelemetry,
  emit,
  isFreshInstall,
  resumeTelemetry,
  sendBackoffMs,
  setTelemetryOn,
  startTelemetry,
  stopTelemetry,
  telemetryFile,
  telemetryStatus,
  type TelemetryDeps
} from '../src/main/telemetry'
import { FUNNEL_PAYLOAD_KEYS, readFunnelPayload } from '../src/shared/funnel-events'

/**
 * THE CLIENT: at most once per install, nothing leaves unless it is on, and a
 * send that fails is a count lost, never something a person notices.
 */

let base = ''
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'telemetry-'))
})
afterEach(() => {
  stopTelemetry()
  rmSync(base, { recursive: true, force: true })
})

interface Sent {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

const wire = (answers: readonly (number | Error)[] = [204]) => {
  const sent: Sent[] = []
  let at = 0
  const fetch: NonNullable<TelemetryDeps['fetch']> = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    const answer = answers[Math.min(at, answers.length - 1)]
    at += 1
    if (answer instanceof Error) throw answer
    return new Response(null, { status: answer })
  }
  return { sent, fetch }
}

const NOW = Date.UTC(2026, 10, 5, 13, 37, 42)

const client = (over: Partial<TelemetryDeps> = {}) => {
  const line = wire()
  const naps: number[] = []
  const telemetry = createTelemetry({
    appVersion: '0.4.0',
    base,
    env: {},
    platform: 'darwin',
    now: () => NOW,
    fetch: line.fetch,
    origin: () => 'https://registry.test',
    sleep: async (ms) => {
      naps.push(ms)
    },
    ...over
  })
  return { telemetry, sent: line.sent, naps }
}

const ledger = (): Record<string, unknown> => JSON.parse(readFileSync(telemetryFile(base), 'utf8')) as Record<string, unknown>
const on = (over: Partial<TelemetryDeps> = {}) => {
  const made = client(over)
  made.telemetry.setOn(true)
  return made
}

describe('off, which is the default', () => {
  it('counts in the local file and sends nothing', async () => {
    const { telemetry, sent } = client()
    expect(telemetry.status()).toEqual({ on: false, locked: false })
    telemetry.emit('installed')
    telemetry.emit('phone_paired')
    await telemetry.settled()
    expect(sent).toEqual([])
    const events = ledger().events as Record<string, { status: string }>
    expect(Object.keys(events).sort()).toEqual(['installed', 'phone_paired'])
    expect(events.installed.status).toBe('local')
  })

  it('mints no install id, so an install that never opts in has no identifier at all', async () => {
    const { telemetry } = client()
    telemetry.emit('installed')
    await telemetry.settled()
    expect(ledger().installId).toBeUndefined()
  })

  it('keeps the file private', () => {
    const { telemetry } = client()
    telemetry.emit('installed')
    expect(statSync(telemetryFile(base)).mode & 0o777).toBe(0o600)
  })
})

describe('COOKREW_TELEMETRY=0', () => {
  it('beats the row, and says so', async () => {
    const { telemetry, sent } = client({ env: { COOKREW_TELEMETRY: '0' } })
    telemetry.setOn(true)
    expect(telemetry.status()).toEqual({ on: false, locked: true })
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toEqual([])
  })

  it('beats a choice already made', async () => {
    client().telemetry.setOn(true)
    const { telemetry, sent } = client({ env: { COOKREW_TELEMETRY: '0' } })
    telemetry.emit('paid')
    await telemetry.settled()
    expect(telemetry.status().on).toBe(false)
    expect(sent).toEqual([])
  })

  it('a row queued before the switch was thrown never leaves, even once the switch is gone', async () => {
    const stuck = on({
      fetch: wire([new Error('offline')]).fetch,
      sleep: async () => {
        throw new Error('the process went away')
      }
    })
    stuck.telemetry.emit('paid')
    await stuck.telemetry.settled()
    const held = client({ env: { COOKREW_TELEMETRY: '0' } })
    await held.telemetry.resume()
    expect(held.sent).toEqual([])
    const back = client()
    await back.telemetry.resume()
    await back.telemetry.settled()
    expect(back.sent).toEqual([])
  })

  it('any other value leaves the row in charge', () => {
    expect(client({ env: { COOKREW_TELEMETRY: '1' } }).telemetry.status()).toEqual({ on: false, locked: false })
  })
})

describe('on', () => {
  it('posts the five allowlisted fields and nothing else', async () => {
    const { telemetry, sent } = on()
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://registry.test/v1/funnel')
    expect(Object.keys(sent[0].body).sort()).toEqual([...FUNNEL_PAYLOAD_KEYS].sort())
    expect(sent[0].body).toMatchObject({ event: 'installed', appVersion: '0.4.0', osFamily: 'mac', day: '2026-11-05' })
    expect(readFunnelPayload(sent[0].body)).not.toBeNull()
  })

  it('carries no credential: the one header says what the body is', async () => {
    const { telemetry, sent } = on()
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent[0].init.method).toBe('POST')
    expect(sent[0].init.headers).toEqual({ 'content-type': 'application/json' })
    expect(sent[0].init.credentials ?? 'omit').toBe('omit')
  })

  it('NEVER: a poisoned environment reaches the wire in no form', async () => {
    const poison = {
      USER: 'alice-the-canary',
      HOME: '/Users/alice-the-canary',
      LOGNAME: 'alice-the-canary',
      COOKREW_HANDLE: 'alice-the-canary',
      PWD: '/Users/alice-the-canary/secret-repo'
    }
    const { telemetry, sent } = on({ env: poison })
    telemetry.emit('installed')
    telemetry.emit('paid')
    await telemetry.settled()
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(sent)).not.toMatch(/alice|canary|secret-repo|\/Users\//)
  })

  it('one install id across events and across restarts', async () => {
    const first = on()
    first.telemetry.emit('installed')
    await first.telemetry.settled()
    const second = client()
    second.telemetry.emit('paid')
    await second.telemetry.settled()
    expect(second.sent[0].body.installId).toBe(first.sent[0].body.installId)
  })

  it('a version the allowlist refuses is not sent at all', async () => {
    const { telemetry, sent } = on({ appVersion: '0.4.0-alice' })
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toEqual([])
  })
})

describe('at most once per install', () => {
  it('a second emit does nothing, in this run', async () => {
    const { telemetry, sent } = on()
    telemetry.emit('phone_paired')
    telemetry.emit('phone_paired')
    await telemetry.settled()
    telemetry.emit('phone_paired')
    await telemetry.settled()
    expect(sent).toHaveLength(1)
  })

  it('or in the next one', async () => {
    const first = on()
    first.telemetry.emit('phone_paired')
    await first.telemetry.settled()
    const second = client()
    second.telemetry.emit('phone_paired')
    await second.telemetry.settled()
    expect(second.sent).toEqual([])
  })

  it('the row is on disk before the request goes, so a crash cannot fire it twice', async () => {
    let onDisk: unknown = null
    const { telemetry } = on({
      fetch: async () => {
        onDisk = (ledger().events as Record<string, unknown>).paid
        return new Response(null, { status: 204 })
      }
    })
    telemetry.emit('paid')
    await telemetry.settled()
    expect(onDisk).toMatchObject({ status: 'queued' })
  })

  it('a ledger that cannot be written sends nothing: unsure means no', async () => {
    const { telemetry, sent } = on()
    rmSync(base, { recursive: true, force: true })
    writeFileSync(base, 'a file where the directory was')
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toEqual([])
    rmSync(base, { force: true })
    mkdirSync(base)
  })
})

describe('turning it on and off', () => {
  it('turning on never sends what happened while it was off', async () => {
    const { telemetry, sent } = client()
    telemetry.emit('installed')
    telemetry.setOn(true)
    await telemetry.resume()
    await telemetry.settled()
    telemetry.emit('installed')
    telemetry.emit('phone_paired')
    await telemetry.settled()
    expect(sent.map((one) => one.body.event)).toEqual(['phone_paired'])
  })

  it('a boot with nothing queued writes nothing', async () => {
    const { telemetry } = client()
    await telemetry.resume()
    expect(existsSync(telemetryFile(base))).toBe(false)
  })

  it('a choice survives a restart', () => {
    client().telemetry.setOn(true)
    expect(client().telemetry.status().on).toBe(true)
    client().telemetry.setOn(false)
    expect(client().telemetry.status().on).toBe(false)
  })

  it('turning off during a backoff stops the retries, and that row stays home for good', async () => {
    const made = on({
      fetch: wire([503]).fetch,
      sleep: async () => {
        made.telemetry.setOn(false)
      }
    })
    made.telemetry.emit('paid')
    await made.telemetry.settled()
    expect((ledger().events as Record<string, { status: string }>).paid.status).toBe('local')
    made.telemetry.setOn(true)
    const line = wire()
    const next = client({ fetch: line.fetch })
    await next.telemetry.resume()
    await next.telemetry.settled()
    expect(line.sent).toEqual([])
  })
})

describe('served sessions and sandboxes', () => {
  it.each([
    ['COOKREW_SERVED', '1'],
    ['COOKREW_SESSION', 'session-1']
  ])('a process marked %s records nothing and sends nothing', async (name, value) => {
    const made = client()
    made.telemetry.setOn(true)
    const { telemetry, sent } = client({ env: { [name]: value } })
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toEqual([])
    expect(ledger().events).toEqual({})
  })

  it('an event from a served card records nothing, and the owner can still earn it', async () => {
    const { telemetry, sent } = on()
    telemetry.emit('first_turn_done', { served: true })
    await telemetry.settled()
    expect(sent).toEqual([])
    telemetry.emit('first_turn_done', { served: false })
    await telemetry.settled()
    expect(sent.map((one) => one.body.event)).toEqual(['first_turn_done'])
  })

  it('in a sandbox the install has no opinion to change either', () => {
    const { telemetry } = client({ env: { COOKREW_SERVED: '1' } })
    telemetry.setOn(true)
    expect(telemetry.status()).toEqual({ on: false, locked: true })
    expect(existsSync(telemetryFile(base))).toBe(false)
  })
})

describe('sending', () => {
  it('emit returns before the network answers', async () => {
    let release: (value: Response) => void = () => undefined
    const { telemetry } = on({ fetch: () => new Promise<Response>((resolve) => (release = resolve)) })
    telemetry.emit('installed')
    expect((ledger().events as Record<string, { status: string }>).installed.status).toBe('queued')
    await Promise.resolve()
    release(new Response(null, { status: 204 }))
    await telemetry.settled()
    expect((ledger().events as Record<string, { status: string }>).installed.status).toBe('sent')
  })

  it('retries a bounded number of times with a backoff, then gives up quietly', async () => {
    const line = wire([new Error('offline')])
    const { telemetry, naps } = on({ fetch: line.fetch })
    expect(() => telemetry.emit('installed')).not.toThrow()
    await telemetry.settled()
    expect(line.sent).toHaveLength(SEND_TRIES)
    expect(naps).toEqual([sendBackoffMs(1), sendBackoffMs(2)])
    expect((ledger().events as Record<string, { status: string }>).installed.status).toBe('dropped')
  })

  it('a 5xx and a 429 are worth another try; the second one lands', async () => {
    const line = wire([503, 429, 204])
    const { telemetry } = on({ fetch: line.fetch })
    telemetry.emit('installed')
    await telemetry.settled()
    expect(line.sent).toHaveLength(3)
    expect((ledger().events as Record<string, { status: string }>).installed.status).toBe('sent')
  })

  it('a 4xx is a refusal: asking again cannot change it', async () => {
    const line = wire([400])
    const { telemetry } = on({ fetch: line.fetch })
    telemetry.emit('installed')
    await telemetry.settled()
    expect(line.sent).toHaveLength(1)
    expect((ledger().events as Record<string, { status: string }>).installed.status).toBe('dropped')
  })

  it('the bound holds across restarts: tries are counted on disk', async () => {
    const line = wire([new Error('offline')])
    let killed = false
    const first = on({
      fetch: line.fetch,
      sleep: async () => {
        killed = true
        throw new Error('the process went away')
      }
    })
    first.telemetry.emit('installed')
    await first.telemetry.settled()
    expect(killed).toBe(true)
    expect(line.sent).toHaveLength(1)
    const next = client({ fetch: line.fetch })
    await next.telemetry.resume()
    await next.telemetry.settled()
    expect(line.sent).toHaveLength(SEND_TRIES)
    const after = client({ fetch: line.fetch })
    await after.telemetry.resume()
    await after.telemetry.settled()
    expect(line.sent).toHaveLength(SEND_TRIES)
  })

  it('a queued event keeps the day it happened', async () => {
    const line = wire([new Error('offline')])
    const first = on({
      fetch: line.fetch,
      sleep: async () => {
        throw new Error('the process went away')
      }
    })
    first.telemetry.emit('installed')
    await first.telemetry.settled()
    const later = wire()
    const next = client({ fetch: later.fetch, now: () => NOW + 3 * 86_400_000 })
    await next.telemetry.resume()
    await next.telemetry.settled()
    expect(later.sent[0].body.day).toBe('2026-11-05')
  })

  it('five events in a burst go one at a time, in the order they happened', async () => {
    const { telemetry, sent } = on()
    telemetry.emit('installed')
    telemetry.emit('preflight_passed', {})
    telemetry.emit('first_turn_done', { served: false })
    telemetry.emit('phone_paired')
    telemetry.emit('paid')
    await telemetry.settled()
    expect(sent.map((one) => one.body.event)).toEqual([
      'installed',
      'preflight_passed',
      'first_turn_done',
      'phone_paired',
      'paid'
    ])
  })
})

describe('a ledger that cannot be read', () => {
  it('reads as off with everything already fired: a lost "no" must not become a yes', async () => {
    mkdirSync(base, { recursive: true })
    writeFileSync(telemetryFile(base), '{"choice":fal')
    const { telemetry, sent } = client({ defaultOn: true })
    expect(telemetry.status().on).toBe(false)
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toEqual([])
  })

  it('an unknown event in the file is ignored, and an emit of one is too', async () => {
    mkdirSync(base, { recursive: true })
    writeFileSync(telemetryFile(base), JSON.stringify({ events: { prompt_sent: { day: 'x', status: 'queued', tries: 0 } } }))
    const { telemetry, sent } = on()
    ;(telemetry.emit as (event: string) => void)('prompt_sent')
    await telemetry.resume()
    await telemetry.settled()
    expect(sent).toEqual([])
    expect(JSON.stringify(ledger())).not.toContain('prompt_sent')
  })

  it('a ledger the process may not read seals too: permission lost is not consent', async () => {
    mkdirSync(base, { recursive: true })
    writeFileSync(telemetryFile(base), JSON.stringify({ choice: false, events: {} }))
    chmodSync(telemetryFile(base), 0o000)
    const { telemetry, sent } = client({ defaultOn: true })
    expect(telemetry.status().on).toBe(false)
    telemetry.emit('installed')
    await telemetry.settled()
    expect(sent).toEqual([])
    chmodSync(telemetryFile(base), 0o600)
  })

  it('a ledger the process may not read still never throws into a caller', () => {
    mkdirSync(base, { recursive: true })
    writeFileSync(telemetryFile(base), '{}')
    chmodSync(telemetryFile(base), 0o000)
    expect(() => client().telemetry.emit('installed')).not.toThrow()
    chmodSync(telemetryFile(base), 0o600)
  })
})

describe('a default the owner may flip', () => {
  it('rules for whoever never chose, and only for them', () => {
    expect(client({ defaultOn: true }).telemetry.status().on).toBe(true)
    client().telemetry.setOn(false)
    expect(client({ defaultOn: true }).telemetry.status().on).toBe(false)
  })
})

describe('the one-line API', () => {
  it('does nothing before start, so a test importing a call site can never write a real home', () => {
    expect(() => emit('installed')).not.toThrow()
    expect(telemetryStatus()).toBeNull()
    expect(setTelemetryOn(true)).toBeNull()
  })

  it('reaches the started client', async () => {
    const line = wire()
    const started = startTelemetry({
      appVersion: '0.4.0',
      base,
      env: {},
      platform: 'linux',
      now: () => NOW,
      fetch: line.fetch,
      origin: () => 'https://registry.test'
    })
    expect(setTelemetryOn(true)).toEqual({ on: true, locked: false })
    emit('paid')
    await started.settled()
    expect(line.sent.map((one) => one.body.event)).toEqual(['paid'])
    expect(line.sent[0].body.osFamily).toBe('linux')
    expect(telemetryStatus()).toEqual({ on: true, locked: false })
    await expect(resumeTelemetry()).resolves.toBeUndefined()
  })

  it('first_turn_done must say whether it was served: the compiler holds the other lane to it', () => {
    // @ts-expect-error a turn runs on served cards too, so the caller has to say
    emit('first_turn_done')
    emit('first_turn_done', { served: false })
  })
})

describe('an install, not an upgrade', () => {
  it('a home with no Cookrew data is a fresh install', () => {
    expect(isFreshInstall(base)).toBe(true)
  })

  it.each(['registry.json', 'workspace.json', 'workspaces'])('a home holding %s is an upgrade', (name) => {
    writeFileSync(path.join(base, name), '{}')
    expect(isFreshInstall(base)).toBe(false)
  })

  it('never reports a fresh install it cannot be sure of', () => {
    const spy = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect(isFreshInstall(base, spy)).toBe(false)
  })
})
