import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootLatency, shouldTimeBoot, type BootSample } from '../src/main/boot-latency'
import {
  HerdrStatusFeed,
  type FeedPane,
  type StatusObservation,
  type StatusSocket
} from '../src/main/herdr-agent-status'
import { EventLog, type CookrewEvent } from '../src/main/event-log'
import { WorkspaceStore } from '../src/main/store'

// terminal.booted — the metric wave 1 consciously SKIPPED (p95-p98 spec).
//
// It was skipped because the only ready signal then available was the
// fork-quiescence probe, whose 25s give-up would have entered the log as a real
// 25000ms sample. So the tests that matter here are not "does it emit" — they
// are the three ways it must stay SILENT:
//
//   reattach — an existing pane is handed back, never booted
//   timeout  — the window closes with no signal; drop the sample, invent nothing
//   exit     — the terminal died before the agent ever arrived
//
// A fabricated tail is worse than a missing metric, because the panel cannot
// tell them apart.

const SAMPLES = (latency: BootLatency): BootSample[] => {
  const seen: BootSample[] = []
  latency.on('booted', (sample: BootSample) => seen.push(sample))
  return seen
}

describe('a COLD spawn is timed from spawn to the agent being there', () => {
  afterEach(() => vi.useRealTimers())

  it('emits one sample carrying how long the boot took', () => {
    let clock = 1_000
    const latency = new BootLatency({ now: () => clock })
    const samples = SAMPLES(latency)

    latency.begin('cookrew_abc', 'term-1')
    clock += 1_840
    latency.ready('cookrew_abc')

    expect(samples).toEqual([{ terminalId: 'term-1', durationMs: 1_840 }])
  })

  it('reports a real, non-negative number for an instant boot', () => {
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    latency.ready('cookrew_abc')
    expect(samples).toHaveLength(1)
    expect(Number.isFinite(samples[0].durationMs)).toBe(true)
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('measures the BOOT: an agent that took 10× longer reports 10× longer', () => {
    let clock = 0
    const latency = new BootLatency({ now: () => clock })
    const samples = SAMPLES(latency)

    latency.begin('cookrew_fast', 'term-fast')
    clock += 600
    latency.ready('cookrew_fast')

    latency.begin('cookrew_slow', 'term-slow')
    clock += 6_000
    latency.ready('cookrew_slow')

    expect(samples.map((s) => s.durationMs)).toEqual([600, 6_000])
  })

  it('emits ONCE — later status churn is not a second boot', () => {
    // herdr pushes every transition, and a booted agent transitions constantly
    // (idle → working → idle on each turn). Only the first observation closes
    // the sample; the rest are somebody else's metric.
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    latency.ready('cookrew_abc')
    latency.ready('cookrew_abc')
    latency.ready('cookrew_abc')
    expect(samples).toHaveLength(1)
    expect(latency.pendingCount).toBe(0)
  })

  it('times each terminal independently when several boot at once', () => {
    let clock = 0
    const latency = new BootLatency({ now: () => clock })
    const samples = SAMPLES(latency)

    latency.begin('cookrew_a', 'term-a')
    clock += 100
    latency.begin('cookrew_b', 'term-b')
    clock += 400
    latency.ready('cookrew_b') // 400ms after ITS start
    clock += 100
    latency.ready('cookrew_a') // 600ms after ITS start

    expect(samples).toEqual([
      { terminalId: 'term-b', durationMs: 400 },
      { terminalId: 'term-a', durationMs: 600 }
    ])
  })
})

describe('shouldTimeBoot — cold spawns only, herdr only', () => {
  it('times a cold spawn on a backend that has a ready signal', () => {
    expect(shouldTimeBoot({ hasReadySignal: true, sessionExists: false })).toBe(true)
  })

  it('refuses a REATTACH: the pane exists, so its agent booted long ago', () => {
    expect(shouldTimeBoot({ hasReadySignal: true, sessionExists: true })).toBe(false)
  })

  it('refuses a backend with no ready signal, cold or not', () => {
    // tmux and the direct backend can say a pane exists; neither can say the
    // agent inside it came up. terminal.booted is herdr-only by construction.
    expect(shouldTimeBoot({ hasReadySignal: false, sessionExists: false })).toBe(false)
    expect(shouldTimeBoot({ hasReadySignal: false, sessionExists: true })).toBe(false)
  })
})

describe('a REATTACH emits nothing', () => {
  it('ignores a ready signal for a session that was never begun', () => {
    // The caller discriminates cold from reattach (sessionExists) and simply
    // does not open a sample for a pane that already existed. Every status the
    // feed then pushes for that pane — and it pushes many — must land nowhere.
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    latency.ready('cookrew_reattached')
    latency.ready('cookrew_reattached')
    expect(samples).toEqual([])
  })

  it('ignores panes belonging to other sessions entirely', () => {
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    latency.ready('cookrew_someone_else')
    expect(samples).toEqual([])
    expect(latency.pendingCount).toBe(1)
  })
})

describe('a TIMEOUT emits nothing — the failure this metric was skipped over', () => {
  afterEach(() => vi.useRealTimers())

  it('drops the sample instead of recording the window as a duration', () => {
    // The exact bug wave 1 refused to ship: a 25s give-up entering the log as a
    // 25000ms boot, manufacturing a P98 tail out of an absent signal.
    vi.useFakeTimers()
    const latency = new BootLatency({ timeoutMs: 15_000 })
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    vi.advanceTimersByTime(15_001)
    expect(samples).toEqual([])
    expect(latency.pendingCount).toBe(0)
  })

  it('stays silent for a ready signal that arrives AFTER the window closed', () => {
    // A pane whose detector only wakes when the user types would otherwise
    // report "time until a human interacted" as a boot latency.
    vi.useFakeTimers()
    const latency = new BootLatency({ timeoutMs: 15_000 })
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    vi.advanceTimersByTime(60_000)
    latency.ready('cookrew_abc')
    expect(samples).toEqual([])
  })

  it('still emits for a slow boot INSIDE the window', () => {
    vi.useFakeTimers()
    const latency = new BootLatency({ timeoutMs: 15_000 })
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    vi.advanceTimersByTime(14_000)
    latency.ready('cookrew_abc')
    expect(samples).toHaveLength(1)
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(14_000)
  })

  it('does not hold the app open waiting for a boot', () => {
    // Unref'd: a pending sample must never be the reason Electron stays alive.
    vi.useFakeTimers()
    const unref = vi.fn()
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((() => ({ unref })) as unknown as typeof setTimeout)
    new BootLatency().begin('cookrew_abc', 'term-1')
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('cancellation', () => {
  it('drops a pending sample when the terminal exits before it is ready', () => {
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    latency.cancel('cookrew_abc')
    latency.ready('cookrew_abc')
    expect(samples).toEqual([])
    expect(latency.pendingCount).toBe(0)
  })

  it('abandons the earlier sample when the same session boots again', () => {
    // Killed and respawned in one breath: the new pane's ready signal must not
    // resolve the dead pane's clock, which would report both boots as one.
    let clock = 0
    const latency = new BootLatency({ now: () => clock })
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    clock += 9_000
    latency.begin('cookrew_abc', 'term-1')
    clock += 300
    latency.ready('cookrew_abc')
    expect(samples).toEqual([{ terminalId: 'term-1', durationMs: 300 }])
  })

  it('cancelAll leaves nothing pending and emits nothing', () => {
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    latency.begin('cookrew_a', 'term-a')
    latency.begin('cookrew_b', 'term-b')
    latency.cancelAll()
    expect(latency.pendingCount).toBe(0)
    latency.ready('cookrew_a')
    expect(samples).toEqual([])
  })

  it('never emits a duration a percentile would have to defend against', () => {
    // A clock that goes backwards (NTP step, injected nonsense) produces NO
    // event rather than a negative sample — the same discipline the store's
    // duration guard holds, one layer earlier.
    const clocks = [5_000, 1_000]
    const latency = new BootLatency({ now: () => clocks.shift() ?? 0 })
    const samples = SAMPLES(latency)
    latency.begin('cookrew_abc', 'term-1')
    latency.ready('cookrew_abc')
    expect(samples).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The ready signal itself: herdr's pushed agent state.
// ---------------------------------------------------------------------------

const EVENT = (paneId: string, status: string): string =>
  JSON.stringify({
    event: 'pane.agent_status_changed',
    data: { pane_id: paneId, agent_status: status }
  })

function fakeSocket(): StatusSocket & { emit: (chunk: string) => void } {
  const handlers: Record<string, ((chunk: string) => void)[]> = {}
  return {
    on(event: string, cb: (chunk: string) => void) {
      ;(handlers[event] ??= []).push(cb)
    },
    write() {},
    end() {},
    emit(chunk: string) {
      for (const cb of handlers.data ?? []) cb(chunk)
    }
  } as never
}

function feedWith(panes: FeedPane[]): {
  feed: HerdrStatusFeed
  socket: ReturnType<typeof fakeSocket>
  seen: StatusObservation[]
} {
  const socket = fakeSocket()
  const feed = new HerdrStatusFeed({
    session: 'cookrew',
    configPath: '/c',
    listPanes: () => panes,
    resolveSocketPath: () => '/tmp/h.sock',
    connect: () => socket
  })
  const seen: StatusObservation[] = []
  feed.on('status', (o: StatusObservation) => seen.push(o))
  feed.start()
  return { feed, socket, seen }
}

describe('the feed ANNOUNCES a known state, keyed by session name', () => {
  it('announces a pushed transition', () => {
    const { socket, seen, feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    socket.emit(EVENT('w1:p1', 'idle') + '\n')
    expect(seen).toEqual([{ sessionName: 'cookrew_abc', status: 'idle' }])
    feed.stop()
  })

  it('announces the SEED too — the common path for a brand-new pane', () => {
    // Subscriptions are per-pane and made at connect time, so a pane created
    // after the last subscription is covered by the refresh that follows the
    // spawn — which learns its state from `pane list`, not from an event.
    // Announcing only socket traffic would lose most cold-boot samples.
    const { seen, feed } = feedWith([
      { paneId: 'w1:p1', label: 'cookrew_abc', status: 'working' }
    ])
    expect(seen).toEqual([{ sessionName: 'cookrew_abc', status: 'working' }])
    feed.stop()
  })

  it('says nothing for `unknown` — a retraction is not a state', () => {
    // herdr reports `unknown` for a pane it cannot read: a shell, or an agent
    // that has not painted yet. Treating it as ready would time the pane's
    // creation rather than the agent's arrival.
    const { socket, seen, feed } = feedWith([
      { paneId: 'w1:p1', label: 'cookrew_abc', status: 'idle' }
    ])
    seen.length = 0
    socket.emit(EVENT('w1:p1', 'unknown') + '\n')
    expect(seen).toEqual([])
    feed.stop()
  })

  it('says nothing about panes Cookrew does not own', () => {
    const { socket, seen, feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    socket.emit(EVENT('w1:p99', 'idle') + '\n')
    expect(seen).toEqual([])
    feed.stop()
  })

  it('still serves the synchronous read turn-tracker depends on', () => {
    // The announcement is additive; the cache this class exists for must not
    // have moved.
    const { socket, feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    socket.emit(EVENT('w1:p1', 'blocked') + '\n')
    expect(feed.statusFor('cookrew_abc')).toBe('blocked')
    feed.stop()
  })

  it('any of herdr\'s four known states counts as "the agent is there"', () => {
    // idle, working, blocked and done all mean the same thing to a boot timer:
    // herdr's detector found an agent, which it cannot do before one is
    // running. Narrowing to `idle` would miss every agent that boots straight
    // into work (a --resume that replays a turn).
    for (const status of ['idle', 'working', 'blocked', 'done']) {
      const { socket, seen, feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
      socket.emit(EVENT('w1:p1', status) + '\n')
      expect(seen).toEqual([{ sessionName: 'cookrew_abc', status }])
      feed.stop()
    }
  })
})

describe('feed → boot timer, wired as index.ts wires them', () => {
  afterEach(() => vi.useRealTimers())

  it('a cold pane\'s first known state closes its sample', () => {
    vi.useFakeTimers()
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    const { socket, feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    feed.on('status', ({ sessionName }: StatusObservation) => latency.ready(sessionName))

    latency.begin('cookrew_abc', 'term-1')
    vi.advanceTimersByTime(1_200)
    socket.emit(EVENT('w1:p1', 'idle') + '\n')

    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ terminalId: 'term-1' })
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(1_200)
    feed.stop()
  })

  it('a reattached pane\'s state churn produces no samples at all', () => {
    const latency = new BootLatency()
    const samples = SAMPLES(latency)
    const { socket, feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_live' }])
    feed.on('status', ({ sessionName }: StatusObservation) => latency.ready(sessionName))

    for (const s of ['working', 'idle', 'working', 'idle']) socket.emit(EVENT('w1:p1', s) + '\n')

    expect(samples).toEqual([])
    feed.stop()
  })
})

// ---------------------------------------------------------------------------
// The store choke-point the emission rides, and the log it lands in.
// ---------------------------------------------------------------------------

function makeStore(): { store: WorkspaceStore; events: CookrewEvent[] } {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-boot-')))
  const events: CookrewEvent[] = []
  store.on('op', (e: CookrewEvent) => events.push(e))
  return { store, events }
}

describe('terminal.booted enters the log through the store, as a timed event', () => {
  it('carries the duration, the terminal and the agent actor', () => {
    const { store, events } = makeStore()
    const latency = new BootLatency()
    latency.on('booted', ({ terminalId, durationMs }: BootSample) =>
      store.withOpContext({ actor: 'agent' }, () =>
        store.recordEvent('terminal.booted', terminalId, 'Forge', undefined, durationMs)
      )
    )
    latency.begin('cookrew_term-1', 'term-1')
    latency.ready('cookrew_term-1')

    const booted = events.find((e) => e.type === 'terminal.booted')
    expect(booted).toMatchObject({ entityId: 'term-1', entityName: 'Forge', actor: 'agent' })
    expect(booted?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('never lands in the log at all when the boot timed out', () => {
    vi.useFakeTimers()
    const { store, events } = makeStore()
    const latency = new BootLatency({ timeoutMs: 15_000 })
    latency.on('booted', ({ terminalId, durationMs }: BootSample) =>
      store.recordEvent('terminal.booted', terminalId, 'Forge', undefined, durationMs)
    )
    latency.begin('cookrew_term-1', 'term-1')
    vi.advanceTimersByTime(20_000)
    latency.ready('cookrew_term-1')

    expect(events.filter((e) => e.type === 'terminal.booted')).toEqual([])
    vi.useRealTimers()
  })

  it('round-trips through the event log with its duration intact', () => {
    const log = new EventLog(
      path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-boot-log-')), 'events.jsonl')
    )
    log.append({
      type: 'terminal.booted',
      entityId: 'term-1',
      entityName: 'Forge',
      workspaceId: 'ws-1',
      workspaceName: 'Cookrew Dev',
      actor: 'agent',
      timestamp: 1_700_000_000_000,
      durationMs: 1_840
    })
    log.flush()
    expect(log.query({ type: 'terminal.booted' })[0].durationMs).toBe(1_840)
  })

  it('carries metadata only — no details string rides along', () => {
    // A boot event names a terminal and a number of milliseconds. Nothing the
    // agent said, and nothing it was asked, is any part of this sample.
    const { store, events } = makeStore()
    store.recordEvent('terminal.booted', 'term-1', 'Forge', undefined, 900)
    const booted = events.find((e) => e.type === 'terminal.booted')
    expect(booted && 'details' in booted).toBe(false)
    expect(Object.keys(booted ?? {}).sort()).toEqual([
      'actor',
      'durationMs',
      'entityId',
      'entityName',
      'timestamp',
      'type',
      'workspaceId',
      'workspaceName'
    ])
  })
})
