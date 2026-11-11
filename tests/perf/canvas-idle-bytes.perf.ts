import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTailSchedule } from '../../src/renderer/src/stream/tail-schedule'
import { createRemoteRevalidation } from '../../src/main/remote-revalidate'
import { createZoomFleetStore, devicesInSightAt, REMOTE_READ_MS } from '../../src/renderer/src/zoom/use-zoom-fleet'
import { zoomThumbClaim } from '../../src/renderer/src/zoom/thumb-claim'
import { relayAccountMachines, ZOOM_ACCOUNT_MAX_AGE_MS } from '../../src/renderer/src/relay-machines'
import type { FleetSnapshot } from '../../src/shared/fleet'
import type { MachineScope } from '../../src/renderer/src/machine-scope'

/**
 * ONE IDLE MINUTE OF THE OWNER'S MAC, BEFORE AND AFTER (bytes 0.6.2).
 *
 * The case the canvas bytes audit measured (2026-11-11, docs/canvas-bytes-audit.html):
 * a console tab sits inside the owner's Mac at its crew (Agents), and Solis-Core's
 * desktop sits at its Devices stop watching the Mac. Nobody touches anything. The
 * Mac's relay uplink measured 2.1 MB a minute that way, 0.53 with Solis alone.
 *
 * Every size below was measured on the real machines that day (route bodies on
 * the wire, compressed as the reader asked; base64 on the relay line not counted).
 * Every "after" count comes from the shipping module that decides it: the tail
 * schedule, the zoom store's Devices-side gate, the thumbnail claim, the shared
 * account list and main's revalidation. The "before" counts are the old rules,
 * written out beside them. Counts, not clocks: this holds on any machine.
 */

const MINUTE = 60_000
/** One relayed round trip from the owner's Mac, p50 (latency 0.6.1). */
const RTT_MS = 372
/** /stream/open for each of the Mac's 24 quiet agents, as it was read (index of 100 rows): bytes in one sweep. */
const TAILS_FULL_SWEEP = 142_426
/** /stream/open?limit=1 for each of them: what the first read of each costs now. */
const TAILS_LIMIT_ONE = [732, 746, 396, 797, 870, 768, 203, 760, 1791, 7906, 1792, 2278, 203, 905, 1009, 527, 203, 562, 1310, 60941, 8554, 19526, 1980, 1125]
const QUIET_AGENTS = TAILS_LIMIT_ONE.length
const SOLIS_FLEET = 791
const MAC_FLEET = 32_874
const THUMBS_BATCH = 740
const ACCOUNT_LIST = 2_346
/** The two push streams, which nothing here changes: /api/events and /api/fleet/stream, gzip, per idle minute. */
const STREAMS_PER_MIN = 70_242 + 1_954

interface Tally {
  requests: number
  bytes: number
}
const add = (a: Tally, b: Tally): Tally => ({ requests: a.requests + b.requests, bytes: a.bytes + b.bytes })

afterEach(() => vi.useRealTimers())

/** The old sweep: every quiet agent, one at a time through the relay, a new sweep at the next 3 s tick after the last ended. */
function tailsBefore(): Tally {
  const sweepMs = QUIET_AGENTS * RTT_MS
  const cycleMs = Math.ceil(sweepMs / 3_000) * 3_000
  const sweeps = MINUTE / cycleMs
  return { requests: Math.round(sweeps * QUIET_AGENTS), bytes: Math.round(sweeps * TAILS_FULL_SWEEP) }
}

/** The schedule, a tick every 3 s, against a machine whose tails have not changed: a 304 for a tag it holds. */
function tailsAfter(): { entry: Tally; idle: Tally } {
  const plan = createTailSchedule()
  const ids = TAILS_LIMIT_ONE.map((_, i) => `agent-${i}`)
  const held = new Set<string>()
  const minute = (from: number): Tally => {
    let tally: Tally = { requests: 0, bytes: 0 }
    for (let at = from; at < from + MINUTE; at += 3_000) {
      for (const id of plan.due(ids, {}, at)) {
        plan.read(id, '', at)
        const i = Number(id.slice('agent-'.length))
        tally = add(tally, { requests: 1, bytes: held.has(id) ? 0 : TAILS_LIMIT_ONE[i] })
        held.add(id)
      }
    }
    return tally
  }
  const entry = minute(0)
  return { entry, idle: minute(MINUTE) }
}

/** The zoom store at the crew of the console: how often another machine's fleet is read in a minute. */
async function otherFleetsAtTheCrew(): Promise<number> {
  vi.useFakeTimers()
  const read = vi.fn(async () => ({ v: 1, rev: 1, at: 0, machine: { id: 's', name: 'Solis-Core' }, workspaces: [] }) as unknown as FleetSnapshot)
  const store = createZoomFleetStore(
    () => ({
      zoomFleetMachines: async () => ({ ok: true, machines: [{ id: 'mac', name: 'Mac', online: true, current: true, workspaces: [], appVersion: '0.6.2' }, { id: 'solis', name: 'Solis-Core', online: true, current: false, workspaces: [], appVersion: '0.6.2' }] as never }),
      listWorkspaces: async () => ({ workspaces: [], activeId: '' }),
      machineName: async () => 'Mac',
      machineFleetOf: read
    }),
    // The crew is v = 1: the Devices side is not in sight.
    { remoteWanted: { now: () => devicesInSightAt(1), watch: () => () => undefined } }
  )
  const off = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(MINUTE)
  off()
  await vi.advanceTimersByTimeAsync(5_000)
  vi.useRealTimers()
  return read.mock.calls.length
}

/** Solis's desktop at its Devices stop: main reads the Mac's fleet every REMOTE_READ_MS, now naming the tag it holds. */
async function solisWatchingTheMac(): Promise<{ before: Tally; after: Tally }> {
  const reads = createRemoteRevalidation()
  const tag = 'W/"mac-fleet"'
  const mac = async (headers: Record<string, string>): Promise<Response> =>
    headers['if-none-match'] === tag ? new Response(null, { status: 304, headers: { etag: tag } }) : new Response('x'.repeat(MAC_FLEET), { status: 200, headers: { etag: tag } })
  const perMinute = MINUTE / REMOTE_READ_MS
  // The first read of the visit, then a minute of the clock.
  await reads.get('mac', 'api/fleet', mac, async (response) => response.text())
  let after: Tally = { requests: 0, bytes: 0 }
  for (let i = 0; i < perMinute; i += 1) {
    const read = await reads.get('mac', 'api/fleet', mac, async (response) => response.text())
    after = add(after, { requests: 1, bytes: read.reused ? 0 : MAC_FLEET })
  }
  return { before: { requests: perMinute, bytes: perMinute * MAC_FLEET }, after }
}

/** The console's two readers of the account's list, each on a 60 s clock: how many questions reach the registry. */
async function accountAsks(): Promise<number> {
  let at = 10_000_000
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', name: 'Mac' }]), { status: 200 }))
  const scope: MachineScope = { machineId: null, relay: { origin: 'https://api.cookrew.dev', session: () => 'perf-session' }, slug: '' }
  // The Devices list at :00, the zoom at :20 (the clocks are not in step), for a minute.
  await relayAccountMachines(scope, fetchImpl, { now: () => at })
  at += 20_000
  await relayAccountMachines(scope, fetchImpl, { now: () => at, maxAgeMs: ZOOM_ACCOUNT_MAX_AGE_MS })
  return fetchImpl.mock.calls.length
}

describe('one idle minute: a console inside the owner’s Mac (at its crew) + Solis-Core watching the Mac (bytes 0.6.2)', () => {
  it('costs a fraction of the requests and the bytes it did', async () => {
    const tails = { before: tailsBefore(), after: tailsAfter() }
    const fleetsRead = await otherFleetsAtTheCrew()
    const solis = await solisWatchingTheMac()
    const asks = await accountAsks()
    // The crew draws neither the deck nor the grid. Its own pictures (the coins) are still claimed where it
    // has them; this crew has none on screen, so the 5 s batch is not asked for at all.
    const thumbsAfter = zoomThumbClaim({ dir: 'agents', v: 1, deck: ['b1'], seen: ['b1', 'b2'], crew: [] }).length > 0 ? MINUTE / 5_000 : 0

    const before: Tally = [
      tails.before,
      { requests: MINUTE / REMOTE_READ_MS, bytes: (MINUTE / REMOTE_READ_MS) * SOLIS_FLEET },
      { requests: MINUTE / 5_000, bytes: (MINUTE / 5_000) * THUMBS_BATCH },
      { requests: 2, bytes: 2 * ACCOUNT_LIST },
      solis.before,
      { requests: 0, bytes: STREAMS_PER_MIN }
    ].reduce(add)
    const after: Tally = [
      tails.after.idle,
      { requests: fleetsRead, bytes: fleetsRead * SOLIS_FLEET },
      { requests: thumbsAfter, bytes: thumbsAfter * THUMBS_BATCH },
      { requests: asks, bytes: asks * ACCOUNT_LIST },
      solis.after,
      { requests: 0, bytes: STREAMS_PER_MIN }
    ].reduce(add)

    console.info(`canvas-idle-bytes ${JSON.stringify({ before, after, tails, solis, fleetsRead, asks, thumbsAfter })}`)

    // The parts, each by the rule that decides it.
    expect(tails.before.requests).toBeGreaterThanOrEqual(140)
    expect(tails.after.idle.requests).toBe(QUIET_AGENTS)
    expect(tails.after.idle.bytes).toBe(0)
    expect(tails.after.entry.bytes).toBe(TAILS_LIMIT_ONE.reduce((sum, one) => sum + one, 0))
    expect(fleetsRead).toBe(0)
    expect(thumbsAfter).toBe(0)
    expect(asks).toBe(1)
    expect(solis.after).toEqual({ requests: MINUTE / REMOTE_READ_MS, bytes: 0 })

    // The minute: about 200 requests and 1.4 MB of bodies before; under 40 and 80 KB after,
    // and what is left is the two push streams, which this work did not touch.
    expect(before.requests).toBeGreaterThan(190)
    expect(before.bytes).toBeGreaterThan(1_400_000)
    expect(after.requests).toBeLessThanOrEqual(40)
    expect(after.bytes).toBeLessThanOrEqual(80_000)
    expect(after.bytes - STREAMS_PER_MIN).toBeLessThanOrEqual(ACCOUNT_LIST)
  })
})
