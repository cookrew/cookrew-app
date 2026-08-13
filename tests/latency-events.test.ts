import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventLog, type CookrewEvent } from '../src/main/event-log'
import { WorkspaceStore } from '../src/main/store'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import type { TerminalNodeData } from '../src/shared/model'

// P95/P98 LATENCY METRICS (Forge lane, note p95-p98-latency-metrics-spec).
//
// The event log counts events but records no durations, so the panel can say
// how OFTEN something happened and never how LONG it took. durationMs is
// OPTIONAL on purpose: absent means untimed, and every consumer that predates
// it must keep working byte-for-byte — which is the first thing pinned below.
//
// Metadata only. A duration is a number of milliseconds; no prompt or reply
// text rides along with it.

// ---------------------------------------------------------------------------
// The schema field.
// ---------------------------------------------------------------------------

function makeLog(): EventLog {
  return new EventLog(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-lat-')), 'events.jsonl'))
}

const event = (over: Partial<CookrewEvent> = {}): CookrewEvent => ({
  type: 'turn.completed',
  entityId: 'term-1',
  entityName: 'Forge',
  workspaceId: 'ws-1',
  workspaceName: 'Cookrew Dev',
  actor: 'agent',
  timestamp: 1_700_000_000_000,
  ...over
})

describe('CookrewEvent.durationMs — optional, and inert when absent', () => {
  it('round-trips a duration through the batched write', () => {
    const log = makeLog()
    log.append(event({ durationMs: 4210 }))
    log.flush()
    expect(log.query({ type: 'turn.completed' })[0].durationMs).toBe(4210)
  })

  it('reads back a duration that only ever lived in the buffer', () => {
    // query() merges unflushed events; a timed one must not lose its duration
    // on the way through that path either.
    const log = makeLog()
    log.append(event({ durationMs: 12 }))
    expect(log.query()[0].durationMs).toBe(12)
  })

  it('leaves an untimed event with NO durationMs key at all', () => {
    // Not null, not undefined-valued: absent. A consumer computing
    // percentiles selects the key's presence, and a null would read as 0.
    const log = makeLog()
    log.append(event({ type: 'note.created' }))
    log.flush()
    const [read] = log.query()
    expect('durationMs' in read).toBe(false)
  })

  it('keeps counting and filtering exactly as before', () => {
    const log = makeLog()
    log.append(event({ durationMs: 100 }))
    log.append(event({ type: 'note.created', timestamp: 1_700_000_000_001 }))
    log.flush()
    expect(log.count()).toEqual({ 'turn.completed': 1, 'note.created': 1 })
    expect(log.query({ type: 'turn.' }).map((e) => e.type)).toEqual(['turn.completed'])
  })
})

// ---------------------------------------------------------------------------
// workspace.switched — initiation through the boot of the target's terminals.
// ---------------------------------------------------------------------------

function makeStore(): { store: WorkspaceStore; events: CookrewEvent[] } {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-lat-store-')))
  const events: CookrewEvent[] = []
  store.on('op', (e: CookrewEvent) => events.push(e))
  return { store, events }
}

describe('workspace.switched carries how long the switch took', () => {
  afterEach(() => vi.useRealTimers())

  it('spans the boot, not just the bookkeeping', () => {
    // The 'switch' listener is where index.ts tears down the outgoing PTYs and
    // boots the incoming ones — synchronously, before the event is emitted. If
    // the window closed any earlier this would read ~0 and the metric would
    // describe nothing anyone waits for.
    vi.useFakeTimers()
    const { store, events } = makeStore()
    const target = store.createWorkspace('Staging', '/work/staging')
    store.on('switch', () => vi.advanceTimersByTime(120))

    store.switchWorkspace(target.id)

    const switched = events.find((e) => e.type === 'workspace.switched')
    expect(switched?.durationMs).toBeGreaterThanOrEqual(120)
  })

  it('is a real number even when the switch is instant', () => {
    const { store, events } = makeStore()
    const target = store.createWorkspace('Staging', '/work/staging')
    store.switchWorkspace(target.id)
    const switched = events.find((e) => e.type === 'workspace.switched')
    expect(Number.isFinite(switched?.durationMs)).toBe(true)
    expect(switched?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('leaves untimed ops untimed — this is not a blanket field', () => {
    const { store, events } = makeStore()
    store.createWorkspace('Staging', '/work/staging')
    const created = events.find((e) => e.type === 'workspace.created')
    expect(created && 'durationMs' in created).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// turn.completed — the thinking → replied transition, from the tracker.
// ---------------------------------------------------------------------------

class FakeSession extends EventEmitter {
  terminalId = 'term-1'
  full = ''
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

interface TurnEvent {
  terminalId: string
  durationMs: number
}

function makeTracker(): {
  tracker: TurnTracker
  session: FakeSession
  turns: TurnEvent[]
} {
  const tracker = new TurnTracker(async () => null, null)
  const session = new FakeSession()
  const turns: TurnEvent[] = []
  tracker.on('turn', (e: TurnEvent) => turns.push(e))
  tracker.track(session as unknown as PtySession, true)
  return { tracker, session, turns }
}

/**
 * Drive one turn to 'replied' after `thinkMs` of genuine work: the session
 * stays BUSY for that long (quiescence is what ends a turn, so a session that
 * goes quiet at once ends at the first eligible poll no matter how far the
 * clock is advanced afterwards), then falls quiet.
 */
async function runTurn(session: FakeSession, prompt: string, thinkMs: number): Promise<void> {
  session.emit('input', `${prompt}\r`)
  session.full = 'working on it…'
  session.idle = 0
  await vi.advanceTimersByTimeAsync(thinkMs)
  session.full = '⏺ done, all tests pass'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
}

describe('TurnTracker announces a completed turn with its duration', () => {
  afterEach(() => vi.useRealTimers())

  it('emits once at the thinking → replied transition', async () => {
    vi.useFakeTimers()
    const { tracker, session, turns } = makeTracker()
    await runTurn(session, 'fix it', 3000)
    expect(tracker.list()[0].phase).toBe('replied')
    expect(turns).toHaveLength(1)
    expect(turns[0].terminalId).toBe('term-1')
    tracker.disposeAll()
  })

  it('measures the WORK: an agent that thought 10× longer reports 10× longer', async () => {
    vi.useFakeTimers()
    const short = makeTracker()
    await runTurn(short.session, 'quick', 3_000)
    short.tracker.disposeAll()

    const long = makeTracker()
    await runTurn(long.session, 'slow', 30_000)
    long.tracker.disposeAll()

    // Each covers at least the time its agent was visibly busy — the number a
    // p95 is supposed to be made of.
    expect(short.turns[0].durationMs).toBeGreaterThanOrEqual(3_000)
    expect(long.turns[0].durationMs).toBeGreaterThanOrEqual(30_000)
    expect(long.turns[0].durationMs).toBeGreaterThan(short.turns[0].durationMs * 5)
    // ...and no more than the quiescence detection that closed it.
    expect(short.turns[0].durationMs).toBeLessThan(3_000 + 3_000)
  })

  it('stays silent for boot noise — a promptless turn nobody asked for', async () => {
    vi.useFakeTimers()
    const { tracker, session, turns } = makeTracker()
    // Output with no input at all: the self-heal path opens a phantom turn,
    // which is discarded rather than recorded. A latency sample from it would
    // be timing an agent's own boot screen.
    session.emit('data', 'Welcome to the harness\n')
    session.full = 'Welcome to the harness'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(30_000)
    expect(turns).toEqual([])
    tracker.disposeAll()
  })

  it('stays silent for a typed slash command — a UI action, not an exchange', async () => {
    vi.useFakeTimers()
    const { tracker, session, turns } = makeTracker()
    await runTurn(session, '/clear', 3000)
    expect(tracker.list()[0].phase).toBe('replied')
    expect(turns).toEqual([])
    tracker.disposeAll()
  })

  it('reports the turn even when the session FILE owns the durable record', async () => {
    // Step 4 of checkpoint-as-identity takes the scrape off history-writing
    // duty for file-backed harnesses. The turn still HAPPENED and still took
    // time — latency must not quietly become claude-less.
    vi.useFakeTimers()
    const { tracker, session, turns } = makeTracker()
    tracker.setHistorySource('term-1', 'file')
    await runTurn(session, 'fix it', 3000)
    expect(turns).toHaveLength(1)
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// The store hand-off the emission actually rides on.
// ---------------------------------------------------------------------------

describe('recordEvent carries a duration for out-of-store emitters', () => {
  const terminal = (id: string): TerminalNodeData => ({
    kind: 'terminal',
    id,
    name: 'Forge',
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  })

  it('emits turn.completed as the AGENT, with its duration', () => {
    const { store, events } = makeStore()
    const node = store.addNode(terminal('term-1'))
    store.withOpContext({ actor: 'agent' }, () =>
      store.recordEvent('turn.completed', node.id, node.name, undefined, 8421)
    )
    const completed = events.find((e) => e.type === 'turn.completed')
    expect(completed).toMatchObject({
      entityId: node.id,
      entityName: 'Forge',
      actor: 'agent',
      durationMs: 8421
    })
  })

  it('refuses a duration that is not a finite count of milliseconds', () => {
    // A NaN or a negative would land straight in a percentile and skew every
    // number above it. Dropping the field beats poisoning the metric.
    const { store, events } = makeStore()
    store.recordEvent('turn.completed', 't', 'Forge', undefined, Number.NaN)
    store.recordEvent('turn.completed', 't', 'Forge', undefined, -5)
    expect(events.every((e) => !('durationMs' in e))).toBe(true)
  })

  it('still emits with no duration at all — the old call shape', () => {
    const { store, events } = makeStore()
    store.recordEvent('role.saved', 'r1', 'Reviewer', 'from Forge')
    expect(events[0]).toMatchObject({ type: 'role.saved', details: 'from Forge' })
    expect('durationMs' in events[0]).toBe(false)
  })
})
