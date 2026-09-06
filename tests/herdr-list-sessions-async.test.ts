import { describe, expect, it, vi } from 'vitest'
import { detachedTerminals, probeDetachedAsync, type ProbeDeps } from '../src/main/board-index'
import { HerdrHostMultiplexer, type AsyncCliRunner } from '../src/main/herdr-host-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'

/**
 * listSessionsAsync — the board probe's inventory read off the main thread
 * (perf/tempo). What is pinned: the SYNC runner is never touched, a good
 * listing is published as the admission inventory so the capture that
 * follows resolves its pane on the async runner too, and a bad listing
 * answers [] without publishing anything.
 */
const envelope = (panes: unknown[]): string => JSON.stringify({ id: 'cli:pane:list', result: { panes } })
const pane = (label: string, id: string) => ({ pane_id: id, label, agent_status: 'unknown' })

function harness(replies: Record<string, string | Error>) {
  const sync: string[][] = []
  const async: string[][] = []
  const runner: CommandRunner = {
    run: (_file, args) => {
      sync.push(args)
      throw new Error('sync runner must not be used')
    },
    runQuiet: (_file, args) => {
      sync.push(args)
    },
    probe: (_file, args) => {
      sync.push(args)
      return true
    }
  }
  const asyncRunner: AsyncCliRunner = async (args) => {
    async.push(args)
    const reply = replies[args.slice(0, 2).join(' ')]
    if (reply === undefined) throw new Error(`no scripted reply for ${args.join(' ')}`)
    if (reply instanceof Error) throw reply
    return reply
  }
  const mux = new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/tmp/c.toml', runner, asyncRunner })
  return { mux, sync, async }
}

describe('HerdrHostMultiplexer.listSessionsAsync', () => {
  it('a failed probe listing does not back admission off', async () => {
    // The probe retries every 3 s; if its failure set the shared backoff, a
    // flaky herdr would keep dispatch admission backed off for good.
    const { mux, async } = harness({ 'pane list': new Error('herdr: os error 35') })
    await expect(mux.listSessionsAsync()).rejects.toThrow()
    const before = async.length
    mux.sessionExistsCached('cookrew_a') // a cold admission read kicks a refresh — unless backed off
    expect(async.length).toBe(before + 1)
    expect(async[async.length - 1].slice(0, 2)).toEqual(['pane', 'list'])
  })

  it('a pass longer than the admission freshness window kicks async refreshes, never a sync child', async () => {
    // What "one inventory per tick" actually means in the field: the probe
    // lists once; a capture past ADMISSION_FRESH_MS (500 ms) finds the cache
    // stale and kicks the refresher — one more ASYNC listing per window, off
    // the main thread. The sync runner stays untouched throughout.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_800_000_000_000)
      const listing = envelope([pane('cookrew_a', 'w1:p1'), pane('cookrew_b', 'w1:p2'), pane('cookrew_c', 'w1:p3')])
      const sync: string[][] = []
      const async: string[][] = []
      const runner: CommandRunner = {
        run: (_f, args) => { sync.push(args); throw new Error('sync') },
        runQuiet: (_f, args) => { sync.push(args) },
        probe: (_f, args) => { sync.push(args); return true }
      }
      const asyncRunner: AsyncCliRunner = async (args) => {
        async.push(args)
        if (args[1] === 'list') return listing
        vi.setSystemTime(Date.now() + 300) // each read costs 300 ms of wall clock
        return 'text'
      }
      const mux = new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/tmp/c.toml', runner, asyncRunner })
      const deps: ProbeDeps = {
        listSessions: () => mux.listSessions(),
        capturePane: (name) => mux.capture(name) ?? '',
        listSessionsAsync: () => mux.listSessionsAsync(),
        capturePaneAsync: async (name) => (await mux.captureAsync(name)) ?? '',
        knownTerminalIds: () => ['a', 'b', 'c'],
        isAttached: () => false,
        sessionNameFor: (id) => `cookrew_${id}`,
        detectWorking: () => true,
        detectWaiting: () => false
      }
      const live = new Set(await deps.listSessionsAsync!())
      const phases = await probeDetachedAsync(deps, detachedTerminals(deps, live))
      expect(phases.size).toBe(3)
      expect(sync).toEqual([])
      const listings = async.filter((a) => a[1] === 'list').length
      expect(listings).toBe(2) // the probe's, plus one refresh once the cache went stale at 600 ms
      expect(async.filter((a) => a[1] === 'read')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists through the async runner only and publishes the inventory', async () => {
    const { mux, sync, async } = harness({
      'pane list': envelope([
        pane('cookrew_a', 'w1:p1'),
        pane('cookrew_b', 'w1:p2'),
        { pane_id: 'w1:p3', label: null }
      ]),
      'pane read': 'some pane text'
    })
    expect(await mux.listSessionsAsync()).toEqual(['cookrew_a', 'cookrew_b'])
    // The capture that follows resolves its pane from THAT read — no cold-cache miss.
    expect(await mux.captureAsync('cookrew_b')).toBe('some pane text')
    expect(async.map((a) => a.slice(0, 3))).toEqual([
      ['pane', 'list'],
      ['pane', 'read', 'w1:p2']
    ])
    expect(sync).toEqual([])
  })

  it('rejects a failed or malformed listing — not an empty fleet — and publishes nothing', async () => {
    const failed = harness({ 'pane list': new Error('herdr: os error 35') })
    await expect(failed.mux.listSessionsAsync()).rejects.toThrow()
    expect(await failed.mux.captureAsync('cookrew_a')).toBeNull() // still cold
    const malformed = harness({ 'pane list': '{"id":"x","result":{"panes":[null]}}' })
    await expect(malformed.mux.listSessionsAsync()).rejects.toThrow()
    expect(failed.sync).toEqual([])
    expect(malformed.sync).toEqual([])
  })

  it('answers from the attach-burst snapshot while one is open, without a child', async () => {
    // beginAttachBatch reads the panes through the SYNC runner (a lifecycle
    // decision, never from a cache); while that snapshot is open the async
    // listing answers from it and spawns nothing.
    const listing = envelope([pane('cookrew_snap', 'w1:p9')])
    const { mux, async, sync } = harness({ 'pane list': envelope([pane('cookrew_late', 'w1:p1')]) })
    const syncRunner = (mux as unknown as { runner: { run: (file: string, args: string[]) => string } }).runner
    syncRunner.run = (_file, args) => {
      sync.push(args)
      if (args[0] === 'pane' && args[1] === 'list') return listing
      throw new Error('unexpected sync call')
    }
    mux.beginAttachBatch()
    expect(await mux.listSessionsAsync()).toEqual(['cookrew_snap'])
    expect(async).toHaveLength(0)
    mux.endAttachBatch()
    expect(await mux.listSessionsAsync()).toEqual(['cookrew_late'])
    expect(async).toHaveLength(1)
  })

  it('an older listing landing after a newer one cannot roll the inventory back', async () => {
    // Two children in flight — the probe's listing and the admission
    // refresher's — finish out of order under load. The pane created between
    // them must stay admitted: the cache moves forward in spawn time only.
    let release: (() => void) | null = null
    const older = new Promise<string>((resolve) => {
      release = () => resolve(envelope([pane('cookrew_a', 'w1:p1')]))
    })
    let calls = 0
    const asyncRunner: AsyncCliRunner = async (args) => {
      if (args[0] === 'pane' && args[1] === 'list') {
        calls += 1
        return calls === 1 ? older : envelope([pane('cookrew_a', 'w1:p1'), pane('cookrew_new', 'w1:p2')])
      }
      return 'text'
    }
    const runner: CommandRunner = {
      run: () => {
        throw new Error('sync')
      },
      runQuiet: () => undefined,
      probe: () => true
    }
    const mux = new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/tmp/c.toml', runner, asyncRunner })
    const first = mux.listSessionsAsync() // spawned first, answers last
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await mux.listSessionsAsync()).toEqual(['cookrew_a', 'cookrew_new'])
    release!()
    expect(await first).toEqual(['cookrew_a'])
    // The newer inventory still stands: the pane created between them resolves.
    expect(await mux.captureAsync('cookrew_new')).toBe('text')
  })
})
