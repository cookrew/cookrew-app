// THE HITL BAR HOLDS WHAT NEEDS YOU ON THE ACCOUNT'S OTHER MACHINES (owner,
// 2026-11-16; plan docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 6). AGENTS:
// each other machine's waiting agents and unread replies, off its fleet snapshot
// (the fleet store's, read slowly while the bar is mounted). ARTIFACTS: what an
// agent changed there, off that machine's own activity log, through one
// allow-listed read. Every entry is that machine's: keyed by machine and id,
// seen in that machine's own book, opened in that machine's view.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetAgent, FleetSnapshot, FleetWorkspace } from '../src/shared/fleet'
import { remoteMachineCall } from '../src/shared/remote-machine-calls'
import { EMPTY_BOOK, type SeenBook } from '../src/renderer/src/zoom/bar-seen'
import { ARTIFACT_TYPES, ENDING_TYPES, type LogEvent } from '../src/renderer/src/zoom/hitl-artifacts'
import {
  createRemoteArtifactFeed,
  eventsOf,
  HITL_REMOTE_MS,
  oneOrder,
  REMOTE_EVENTS_ROUTE,
  remoteAgentLabel,
  remoteAgentsOf,
  remoteItemLabel,
  remoteItemsOf,
  remoteKey,
  machineMark,
  type RemoteMachineRead
} from '../src/renderer/src/zoom/remote-hitl'
import { createHitlWant } from '../src/renderer/src/zoom/remote-hitl-want'
import { resolveRemoteTarget, type RemoteTarget } from '../src/renderer/src/zoom/remote-open'
import type { RemoteCard } from '../src/renderer/src/zoom/remote-machine'
import { buildFleet, type FleetInput } from '../src/main/fleet/build'
import type { WorkspaceMeta } from '../src/shared/model'

const MINI = '0f8c7b1e-1234-4abc-9def-0123456789ab'
const ATTIC = '1a2b3c4d-1234-4abc-9def-0123456789ab'

const agent = (id: string, phase: FleetAgent['phase'], since: number | null, over: Partial<FleetAgent> = {}): FleetAgent => ({
  id, name: `agent ${id}`, harness: 'claude', model: null, orch: false, phase, phaseSource: 'live', phaseSince: since,
  task: 'a task', reply: 'a reply', turns: 1, attachments: [], ...over
})
const ws = (id: string, agents: FleetAgent[], over: Partial<FleetWorkspace> = {}): FleetWorkspace => ({
  id, name: `GOAT ${id}`, icon: null, state: 'background', agents, loose: [], counts: { agents: agents.length, notes: 0, browsers: 0 }, ...over
})
const snap = (workspaces: FleetWorkspace[], at = 1000): FleetSnapshot => ({
  v: 1, rev: 1, at, machine: { name: 'Mac mini.local', appVersion: '0.6.8', profile: { kind: 'desktop', model: null, label: null, vendor: null, os: 'darwin', osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [] } },
  focusedWorkspaceId: null, workspaces
})
const machine = (id: string, name: string, workspaces: FleetWorkspace[]): RemoteMachineRead => ({ id, name, snapshot: snap(workspaces) })
const ev = (type: string, id: string, at: number, over: Partial<LogEvent> = {}): LogEvent => ({
  type, entityId: id, entityName: `card ${id}`, workspaceId: 'w1', workspaceName: 'GOAT w1', actor: 'agent', timestamp: at, ...over
})

describe('the AGENTS of another machine', () => {
  it('waiting and unread replies only, from its fleet snapshot, keyed by machine and id', () => {
    const reads = [machine(MINI, 'Mac mini', [ws('w1', [agent('a', 'waiting', 50), agent('b', 'replied', 70), agent('c', 'thinking', 90), agent('d', 'idle', 10), agent('e', 'offline', 5)])])]
    const out = remoteAgentsOf(reads)
    expect(out.map((e) => [e.agentId, e.why, e.at])).toEqual([['a', 'waiting', 50], ['b', 'reply', 70]])
    expect(out[0]).toMatchObject({ key: remoteKey(MINI, 'a'), machineId: MINI, machineName: 'Mac mini', workspaceId: 'w1', workspaceName: 'GOAT w1' })
  })

  it('the same id on two machines is two entries, never merged by id or name', () => {
    const reads = [machine(MINI, 'Mac mini', [ws('w1', [agent('a', 'waiting', 1)])]), machine(ATTIC, 'Attic', [ws('w1', [agent('a', 'waiting', 2)])])]
    const keys = remoteAgentsOf(reads).map((e) => e.key)
    expect(new Set(keys).size).toBe(2)
    expect(remoteKey(MINI, 'a')).not.toBe(remoteKey(ATTIC, 'a'))
    expect(remoteKey(MINI, 'a')).not.toBe('a')
  })

  it("a served workspace is a customer's: none of its agents are here", () => {
    const reads = [machine(MINI, 'Mac mini', [ws('w1', [agent('a', 'waiting', 1)], { served: true }), ws('w2', [agent('b', 'waiting', 1)])])]
    expect(remoteAgentsOf(reads).map((e) => e.agentId)).toEqual(['b'])
  })

  it('a phase with no time takes the snapshot time', () => {
    const out = remoteAgentsOf([machine(MINI, 'Mac mini', [ws('w1', [agent('a', 'waiting', null)])])])
    expect(out[0].at).toBe(1000)
  })

  it('says where it is: its workspace and its machine', () => {
    const [e] = remoteAgentsOf([machine(MINI, 'Mac mini', [ws('w1', [agent('a', 'waiting', 1)], { name: 'GOAT Team' })])])
    expect(remoteAgentLabel(e)).toBe('agent a, needs you, in GOAT Team, on Mac mini')
    const [r] = remoteAgentsOf([machine(MINI, 'Mac mini', [ws('w1', [agent('b', 'replied', 1)], { name: 'GOAT Team' })])])
    expect(remoteAgentLabel(r)).toBe('agent b, replied, in GOAT Team, on Mac mini')
    expect(machineMark('mac mini')).toBe('M')
    expect(machineMark('  ')).toBe('?')
  })
})

describe('the ARTIFACTS of another machine', () => {
  const book = (over: Partial<SeenBook> = {}): SeenBook => ({ ...EMPTY_BOOK, cutoff: 0, ...over })
  const read = machine(MINI, 'Mac mini', [ws('w1', []), ws('w2', [], { served: true })])

  it("an agent's change there after the starting point, keyed by machine and id", () => {
    const items = remoteItemsOf(read, eventsOf({ events: [ev('note.updated', 'n', 20), ev('browser.navigated', 'b', 30)] }), book())
    expect(items.map((e) => [e.id, e.kind, e.at])).toEqual([['b', 'browser', 30], ['n', 'note', 20]])
    expect(items[0]).toMatchObject({ key: remoteKey(MINI, 'b'), machineId: MINI, machineName: 'Mac mini', workspaceName: 'GOAT w1' })
  })

  it("seen in that machine's own book; nothing before its starting point; nothing until it has one", () => {
    const events = eventsOf({ events: [ev('note.updated', 'n', 20), ev('note.updated', 'm', 40)] })
    expect(remoteItemsOf(read, events, book({ seen: { n: 20 } })).map((e) => e.id)).toEqual(['m'])
    expect(remoteItemsOf(read, events, book({ cutoff: 30 })).map((e) => e.id)).toEqual(['m'])
    expect(remoteItemsOf(read, events, EMPTY_BOOK)).toEqual([])
  })

  it("the owner's own changes, a served workspace's and an unknown one's are not news; a deletion ends one", () => {
    const events = eventsOf({
      events: [
        ev('note.updated', 'own', 20, { actor: 'user' }),
        ev('note.updated', 'served', 20, { workspaceId: 'w2' }),
        ev('note.updated', 'lost', 20, { workspaceId: 'gone' }),
        ev('note.created', 'del', 20), ev('note.deleted', 'del', 25)
      ]
    })
    expect(remoteItemsOf(read, events, book())).toEqual([])
  })

  it('reads only well-formed rows, and at most a bounded number', () => {
    expect(eventsOf(null).entries.size).toBe(0)
    expect(eventsOf({ events: 'no' }).entries.size).toBe(0)
    expect(eventsOf({ events: [{ type: 'note.created' }, ev('note.created', 'n', 1)] }).entries.size).toBe(1)
  })

  it('says where it is', () => {
    const [e] = remoteItemsOf(read, eventsOf({ events: [ev('note.updated', 'n', 20, { entityName: 'Plan' })] }), book())
    expect(remoteItemLabel(e)).toBe('Note: Plan, in GOAT w1, on Mac mini, new')
  })
})

describe('one order across this machine and the others', () => {
  it('waiting first, then replies and news, newest first within, whichever machine', () => {
    const order = oneOrder([
      { key: 'l-reply', why: 'reply' as const, at: 90 },
      { key: 'r-wait-old', why: 'waiting' as const, at: 10 },
      { key: 'l-wait', why: 'waiting' as const, at: 50 },
      { key: 'r-reply', why: 'reply' as const, at: 95 }
    ])
    expect(order.map((e) => e.key)).toEqual(['l-wait', 'r-wait-old', 'r-reply', 'l-reply'])
  })
})

describe("the read of another machine's log", () => {
  it('one allow-listed route, the same each time (its tag makes an unchanged log a 304)', () => {
    expect(REMOTE_EVENTS_ROUTE).toBe(`api/events/query?types=${[...ARTIFACT_TYPES, ...ENDING_TYPES].join(',')}&limit=300`)
    expect(remoteMachineCall('GET', REMOTE_EVENTS_ROUTE)).not.toBeNull()
  })

  it('the allow-list takes type, types, since and limit, bounded, and nothing else', () => {
    const ok = ['api/events/query?type=note.created&limit=200', 'api/events/query?type=note.deleted&since=1731700000000', 'api/events/query?types=note.created,browser.closed&since=5&limit=10']
    for (const route of ok) expect(remoteMachineCall('GET', route), route).not.toBeNull()
    const refused = [
      'api/events/query',
      'api/events/query?workspaceId=w1',
      'api/events/query?type=note.created&until=5',
      'api/events/query?limit=12345',
      'api/events/query?since=-1',
      'api/events/query?type=Note%20created',
      `api/events/query?type=${'a'.repeat(65)}`,
      `api/events/query?types=${Array.from({ length: 17 }, () => 'a').join(',')}`,
      'api/events/query?type=a&type=b&type=c&type=d&type=e',
      'api/events/query/../fleet',
      'api/events?type=a'
    ]
    for (const route of refused) expect(remoteMachineCall('GET', route), route).toBeNull()
    expect(remoteMachineCall('POST', 'api/events/query?type=a')).toBeNull()
  })
})

describe('the feed of the other machines’ logs', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (answer: (machineId: string) => { status: number; body: unknown }) => {
    const call = vi.fn(async (machineId: string, _route: string) => answer(machineId))
    let machines: string[] = [MINI]
    let hidden = false
    let sightChanged: (() => void) | null = null
    const want = createHitlWant()
    const cutoffs: [string, number][] = []
    const books = new Map<string, SeenBook>()
    const feed = createRemoteArtifactFeed({
      call,
      machines: () => machines,
      want,
      sight: { hidden: () => hidden, watch: (cb) => ((sightChanged = cb), () => void (sightChanged = null)) },
      cutoffOf: (id) => books.get(id)?.cutoff ?? null,
      onCutoff: (id, at) => {
        cutoffs.push([id, at])
        books.set(id, { ...EMPTY_BOOK, cutoff: at })
      }
    })
    return { call, feed, want, cutoffs, setMachines: (next: string[]) => (machines = next), hide: (next: boolean) => ((hidden = next), sightChanged?.()) }
  }

  it('reads nothing until the bar wants it, then each machine on the slow clock, and stops when hidden', async () => {
    const { call, feed, want, hide } = setup(() => ({ status: 200, body: { events: [] } }))
    feed.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(call).not.toHaveBeenCalled()
    const release = want.claim()
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]).toEqual([MINI, REMOTE_EVENTS_ROUTE])
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS * 2)
    expect(call).toHaveBeenCalledTimes(3)
    hide(true)
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS * 4)
    expect(call).toHaveBeenCalledTimes(3)
    hide(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledTimes(4)
    release()
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS * 4)
    expect(call).toHaveBeenCalledTimes(4)
  })

  it("first sight of a machine starts its book at that machine's own newest change: no flood", async () => {
    const { feed, want, cutoffs } = setup(() => ({ status: 200, body: { events: [ev('note.created', 'n', 40), ev('note.deleted', 'x', 99), ev('note.updated', 'n', 70)] } }))
    feed.subscribe(() => undefined)
    want.claim()
    await vi.advanceTimersByTimeAsync(0)
    expect(cutoffs).toEqual([[MINI, 70]])
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS)
    expect(cutoffs).toHaveLength(1)
  })

  it('an unchanged log is the same state (no re-render); a machine that stops answering or refuses leaves nothing behind', async () => {
    let status = 200
    const { feed, want, setMachines } = setup(() => ({ status, body: status === 200 ? { events: [ev('note.created', 'n', 40)] } : null }))
    const heard = vi.fn()
    feed.subscribe(heard)
    want.claim()
    await vi.advanceTimersByTimeAsync(0)
    const first = feed.get()
    expect(first.get(MINI)?.entries.has('n')).toBe(true)
    const told = heard.mock.calls.length
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS)
    expect(feed.get()).toBe(first)
    expect(heard.mock.calls.length).toBe(told)
    status = 401
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS)
    expect(feed.get().has(MINI)).toBe(false)
    status = 200
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS)
    expect(feed.get().has(MINI)).toBe(true)
    // Gone from the fleet's readable machines (offline, too old): dropped at once, asked nothing more.
    setMachines([])
    feed.machinesChanged()
    expect(feed.get().has(MINI)).toBe(false)
  })

  it('a machine newly readable is read at once, not a slow tick later', async () => {
    const { call, feed, want, setMachines } = setup(() => ({ status: 200, body: { events: [] } }))
    feed.subscribe(() => undefined)
    want.claim()
    await vi.advanceTimersByTimeAsync(0)
    setMachines([MINI, ATTIC])
    feed.machinesChanged()
    await vi.advanceTimersByTimeAsync(0)
    // Only the new one: the others keep their clock.
    expect(call.mock.calls.map(([id]) => id)).toEqual([MINI, ATTIC])
  })

  it('stopped (another machine in scope), it drops what it read and asks nothing more', async () => {
    const { call, feed, want } = setup(() => ({ status: 200, body: { events: [ev('note.created', 'n', 40)] } }))
    feed.subscribe(() => undefined)
    want.claim()
    await vi.advanceTimersByTimeAsync(0)
    feed.stop()
    expect(feed.get().size).toBe(0)
    await vi.advanceTimersByTimeAsync(HITL_REMOTE_MS * 3)
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe("the bar's want", () => {
  it('is held while any bar is mounted, and says when that changes', () => {
    const want = createHitlWant()
    const changed = vi.fn()
    want.watch(changed)
    expect(want.now()).toBe(false)
    const a = want.claim()
    const b = want.claim()
    expect(want.now()).toBe(true)
    a()
    a()
    expect(want.now()).toBe(true)
    b()
    expect(want.now()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('opening a remote face: the machine first, the agent once its view has it', () => {
  const card = (id: string, workspace: string, items: string[] = []): RemoteCard => ({
    id, name: `agent ${id}`, preset: 'claude', orch: false, workspace: { id: workspace, name: workspace }, status: 'waiting', word: 'needs you',
    words: null, about: null, choice: null, items: items.map((one) => ({ id: one, kind: 'note', title: one })) as unknown as RemoteCard['items'], browsers: 0, notes: items.length
  })
  const target = (over: Partial<RemoteTarget> = {}): RemoteTarget => ({
    machineId: MINI, workspaceId: 'w1', kind: 'agent', id: 'a', name: 'agent a', at: 1000, ...over
  })
  const place = { machineId: MINI, workspaceId: 'w1' }

  it('waits while nothing is read, goes to the agent once the read has it', () => {
    expect(resolveRemoteTarget(target(), place, null, 1100)).toEqual({ step: 'wait' })
    expect(resolveRemoteTarget(target(), place, [card('b', 'w1')], 1100)).toEqual({ step: 'wait' })
    expect(resolveRemoteTarget(target(), place, [card('a', 'w1')], 1100)).toEqual({ step: 'agent', agent: { id: 'a', name: 'agent a' } })
  })

  it('the owner moved on inside that machine first: their place stands', () => {
    expect(resolveRemoteTarget(target(), { ...place, agentId: 'b' }, [card('a', 'w1')], 1100)).toEqual({ step: 'drop' })
  })

  it('never a wrong target: another machine, another workspace, a card of another workspace', () => {
    expect(resolveRemoteTarget(target(), { ...place, machineId: ATTIC }, [card('a', 'w1')], 1100)).toEqual({ step: 'drop' })
    expect(resolveRemoteTarget(target(), { ...place, workspaceId: 'w2' }, [card('a', 'w1')], 1100)).toEqual({ step: 'drop' })
    expect(resolveRemoteTarget(target(), place, [card('a', 'w9')], 1100)).toEqual({ step: 'wait' })
  })

  it('an artifact opens on the card that holds it; loose or gone, the workspace artifacts once the wait is over', () => {
    const item = target({ kind: 'item', id: 'n1', name: 'Plan', itemKind: 'note' })
    expect(resolveRemoteTarget(item, place, [card('a', 'w1', ['n1'])], 1100)).toEqual({
      // As that machine names it now.
      step: 'item', agent: { id: 'a', name: 'agent a' }, item: { id: 'n1', title: 'n1', kind: 'note' }
    })
    expect(resolveRemoteTarget(item, place, [card('a', 'w1')], 1100)).toEqual({ step: 'wait' })
    expect(resolveRemoteTarget(item, place, [card('a', 'w1')], 1000 + 60_000)).toEqual({ step: 'items' })
  })

  it('times out on the machine: an agent never found is no target', () => {
    expect(resolveRemoteTarget(target(), place, [card('b', 'w1')], 1000 + 60_000)).toEqual({ step: 'drop' })
  })
})

describe('the source contract', () => {
  const read = (...p: string[]): string => readFileSync(join(__dirname, '../src', ...p), 'utf8')
  it('the page fleet store reads the other machines slowly while the bar wants them', () => {
    expect(read('renderer/src/zoom/use-zoom-fleet.ts')).toContain('remoteBackground: hitlWant')
  })
  it('the bar claims the want while mounted and draws the remote faces read-only', () => {
    const groups = read('renderer/src/zoom/BarGroups.tsx')
    expect(groups).toContain('useRemoteHitl()')
    expect(groups).toMatch(/kind: 'agent', id: [\s\S]{0,40}away: true/)
  })
  it("the remote view settles a pending open from its own read", () => {
    expect(read('renderer/src/zoom/RemoteMachineView.tsx')).toContain('remoteOpen.settle(')
  })
})

describe('the fleet a machine serves marks a served workspace', () => {
  const input = (meta: WorkspaceMeta): FleetInput => ({
    workspaces: [{ meta, state: { name: meta.name, dir: '/w', dirs: ['/w'], nodes: [], connections: [] } }],
    focusedWorkspaceId: null, live: new Map(), probe: new Map(), ledger: new Map(), tuning: () => null, harnessOf: () => 'shell', memory: new Map(), now: 0
  })
  const meta: WorkspaceMeta = { id: 'w1', name: 'One', dir: '/w', dirs: ['/w'], icon: '' }
  it("served: so another machine's bar leaves it out; otherwise the row is as it always was", () => {
    expect(buildFleet(input({ ...meta, served: true })).workspaces[0].served).toBe(true)
    expect('served' in buildFleet(input(meta)).workspaces[0]).toBe(false)
  })
})
