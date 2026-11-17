// THE HITL BAR READS THE ACTIVITY LOG, ACROSS WORKSPACES (owner, 2026-11-16;
// plan docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 2). AGENTS: every
// workspace's waiting agents and unread replies (the crew). ARTIFACTS: the
// notes and browsers an AGENT made or changed since you last looked, read off
// the event log the main process writes (phase 1). The owner's own edits never
// count; a served workspace is a customer's and never counts; a face from
// another workspace opens a read-only card, and the second tap jumps there.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { EventLog, type CookrewEvent, type EventQuery } from '../src/main/event-log'
import { describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_TYPES,
  BOOT_LIMIT,
  ENDING_TYPES,
  artifactInbox,
  asLogEvent,
  createArtifactFeed,
  EMPTY_ARTIFACTS,
  foldArtifacts,
  type ArtifactEntry,
  type LogEvent
} from '../src/renderer/src/zoom/hitl-artifacts'
import { BOOK_KEY, bookKeyFor, EMPTY_BOOK, loadBook, markSeen, OLD_BOOK_KEY, pruneBook, readBook, withCutoff } from '../src/renderer/src/zoom/bar-seen'
import { badgeOf, inboxRows, secondTap, type WorkspaceFace } from '../src/renderer/src/zoom/bar-reach'
import { agentInbox } from '../src/renderer/src/zoom/bar-inbox'
import { barCard } from '../src/renderer/src/zoom/bar-pick'

const ev = (type: string, id: string, at: number, over: Partial<LogEvent> = {}): LogEvent => ({
  type, entityId: id, entityName: `card ${id}`, workspaceId: 'w1', workspaceName: 'Cookrew Dev', actor: 'agent', timestamp: at, ...over
})
const entries = (state: { entries: ReadonlyMap<string, ArtifactEntry> }) => [...state.entries.values()]

describe('what the log says an agent made or changed', () => {
  it("an agent's note and browser events are artifacts, the newest of each card kept", () => {
    const state = foldArtifacts(EMPTY_ARTIFACTS, [
      ev('note.created', 'n', 10), ev('note.updated', 'n', 20), ev('browser.navigated', 'b', 15)
    ])
    expect(entries(state).map((e) => [e.id, e.kind, e.at])).toEqual([['n', 'note', 20], ['b', 'browser', 15]])
  })

  it("the owner's own changes are not an agent's", () => {
    const state = foldArtifacts(EMPTY_ARTIFACTS, [ev('note.updated', 'n', 10, { actor: 'user' })])
    expect(entries(state)).toEqual([])
  })

  it("an orch's changes count like any agent's", () => {
    expect(entries(foldArtifacts(EMPTY_ARTIFACTS, [ev('note.created', 'n', 10, { actor: 'orch' })]))).toHaveLength(1)
  })

  it('an older event arriving late does not move the card back in time', () => {
    const state = foldArtifacts(foldArtifacts(EMPTY_ARTIFACTS, [ev('note.updated', 'n', 30)]), [ev('note.created', 'n', 10)])
    expect(entries(state)[0].at).toBe(30)
  })

  it('a deleted card leaves; a change from before its deletion arriving late does not bring it back', () => {
    let state = foldArtifacts(EMPTY_ARTIFACTS, [ev('note.created', 'n', 10), ev('note.deleted', 'n', 20)])
    expect(entries(state)).toEqual([])
    state = foldArtifacts(state, [ev('note.updated', 'n', 15)])
    expect(entries(state)).toEqual([])
  })

  it('a deleted workspace takes its cards with it', () => {
    const state = foldArtifacts(EMPTY_ARTIFACTS, [
      ev('note.created', 'n', 10), ev('workspace.deleted', 'w1', 20, { entityId: 'w1' })
    ])
    expect(entries(state)).toEqual([])
  })

  it('nothing new is the same state (no re-render)', () => {
    const state = foldArtifacts(EMPTY_ARTIFACTS, [ev('note.created', 'n', 10)])
    expect(foldArtifacts(state, [ev('terminal.booted', 't', 30)])).toBe(state)
    expect(foldArtifacts(state, [ev('note.created', 'n', 10)])).toBe(state)
  })

  it('reads only well-formed rows off the wire', () => {
    expect(asLogEvent({ ...ev('note.created', 'n', 1) })).not.toBeNull()
    expect(asLogEvent({ type: 'note.created' })).toBeNull()
    expect(asLogEvent(null)).toBeNull()
    expect(asLogEvent({ ...ev('note.created', 'n', 1), timestamp: 'soon' })).toBeNull()
  })
})

describe('what the ARTIFACTS group holds', () => {
  const ws = new Map<string, WorkspaceFace>([['w1', { name: 'Cookrew Dev', icon: null }], ['w2', { name: 'GOAT Team', icon: '🐐' }], ['s', { name: 'Door', icon: null, served: true }]])
  const place = { workspaces: ws, here: 'w1', onCanvas: () => true }
  const pool = (list: LogEvent[]) => entries(foldArtifacts(EMPTY_ARTIFACTS, list))

  it('nothing before the starting point is set (the log still loading)', () => {
    expect(artifactInbox(pool([ev('note.created', 'n', 10)]), EMPTY_BOOK, place)).toEqual([])
  })

  it('only what an agent changed after the starting point, newest first, across workspaces', () => {
    const book = withCutoff(EMPTY_BOOK, 15)
    const list = pool([ev('note.created', 'old', 10), ev('note.created', 'a', 20), ev('browser.navigated', 'b', 30, { workspaceId: 'w2' })])
    expect(artifactInbox(list, book, place).map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('opened, it leaves; an agent changing it again brings it back', () => {
    let book = markSeen(withCutoff(EMPTY_BOOK, 0), 'a', 20)
    expect(artifactInbox(pool([ev('note.created', 'a', 20)]), book, place)).toEqual([])
    expect(artifactInbox(pool([ev('note.updated', 'a', 25)]), book, place).map((e) => e.id)).toEqual(['a'])
    book = markSeen(book, 'a', 25)
    expect(artifactInbox(pool([ev('note.updated', 'a', 25)]), book, place)).toEqual([])
  })

  it("a served workspace's cards and an unknown workspace's are not the owner's to see", () => {
    const book = withCutoff(EMPTY_BOOK, 0)
    const list = pool([ev('note.created', 's1', 10, { workspaceId: 's' }), ev('note.created', 'x1', 10, { workspaceId: 'gone' })])
    expect(artifactInbox(list, book, { ...place, onCanvas: () => false })).toEqual([])
  })

  it('a card moved onto the open canvas (a team move logs no per-card event) is here', () => {
    const book = withCutoff(EMPTY_BOOK, 0)
    const list = pool([ev('note.created', 'm', 10, { workspaceId: 'gone' })])
    expect(artifactInbox(list, book, { ...place, onCanvas: (id) => id === 'm' }).map((e) => e.id)).toEqual(['m'])
  })

  it("a card of the open workspace no longer on its canvas (moved away) is not shown", () => {
    const book = withCutoff(EMPTY_BOOK, 0)
    expect(artifactInbox(pool([ev('note.created', 'n', 10)]), book, { ...place, onCanvas: () => false })).toEqual([])
  })
})

describe('the seen book v2: what time each card was last looked at', () => {
  it('a look only ever moves forward; the same look is the same book', () => {
    const book = markSeen(EMPTY_BOOK, 'a', 20)
    expect(markSeen(book, 'a', 10)).toBe(book)
    expect(markSeen(book, 'a', 20)).toBe(book)
    expect(markSeen(book, 'a', 30).seen.a).toBe(30)
  })

  it('the starting point is set once, by the first boot, and never moved', () => {
    const book = withCutoff(EMPTY_BOOK, 100)
    expect(book.cutoff).toBe(100)
    expect(withCutoff(book, 500)).toBe(book)
  })

  it('reads back what it wrote, and anything unreadable as empty', () => {
    const book = markSeen(withCutoff(EMPTY_BOOK, 5), 'a', 9)
    expect(readBook(JSON.stringify(book))).toEqual(book)
    expect(readBook('{broken')).toEqual(EMPTY_BOOK)
    expect(readBook(JSON.stringify({ cutoff: 'x', seen: { a: 'y', b: 3 } }))).toEqual({ cutoff: null, seen: { b: 3 } })
  })

  it('a big book drops what is no longer an artifact', () => {
    const big = { cutoff: 0, seen: Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`n${i}`, i + 1])) }
    const pruned = pruneBook(big, (id) => id === 'n7')
    expect(Object.keys(pruned.seen)).toEqual(['n7'])
    expect(pruneBook(markSeen(EMPTY_BOOK, 'a', 1), () => false).seen).toEqual({ a: 1 })
  })

  it('the old content-signature book is forgotten on load', () => {
    const store = new Map<string, string>([[OLD_BOOK_KEY, '{"w":{}}'], [BOOK_KEY, JSON.stringify({ cutoff: 3, seen: { a: 4 } })]])
    const storage = { getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) }
    expect(loadBook(storage, BOOK_KEY)).toEqual({ cutoff: 3, seen: { a: 4 } })
    expect(store.has(OLD_BOOK_KEY)).toBe(false)
  })

  it("each machine keeps its own book: its times are its clock, its ids its cards", () => {
    expect(bookKeyFor(null)).toBe(BOOK_KEY)
    expect(bookKeyFor('m-1')).toBe(`${BOOK_KEY}:m-1`)
  })
})

describe('the feed: the log read once at boot, then followed', () => {
  function fakeApi(rows: Record<string, LogEvent[]>) {
    let live: ((raw: unknown) => void) | null = null
    // The REAL log answers (event-log.ts), the rows appended in time order:
    // the feed is tested against the query it will meet, not a copy of it.
    const log = new EventLog(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-hitl-feed-')), 'events.jsonl'), { flushMs: 60_000 })
    // The feed's LogEvent reads `actor` as any string; the log's own type is the union it writes.
    for (const e of Object.values(rows).flat().sort((a, b) => a.timestamp - b.timestamp)) log.append(e as CookrewEvent)
    log.flush()
    const api = {
      queryEvents: vi.fn((q?: unknown) => Promise.resolve(log.query((q ?? {}) as EventQuery))),
      onEvent: vi.fn((cb: (raw: unknown) => void) => {
        live = cb
        return () => undefined
      })
    }
    return { api, push: (e: LogEvent) => live?.(e) }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('asks for every artifact type in ONE read with a limit, folds them, and sets the starting point at the newest', async () => {
    const { api } = fakeApi({ 'note.created': [ev('note.created', 'n', 10)], 'browser.navigated': [ev('browser.navigated', 'b', 40, { actor: 'user' })] })
    const cutoffs: number[] = []
    const feed = createArtifactFeed(api, (at) => void cutoffs.push(at))
    feed.start()
    await flush()
    // One round trip, not one per type: through the relay each is an exchange of the phone's boot.
    expect(api.queryEvents).toHaveBeenNthCalledWith(1, { types: [...ARTIFACT_TYPES], limitPerType: BOOT_LIMIT })
    expect(cutoffs).toEqual([40])
    expect(entries(feed.get()).map((e) => e.id)).toEqual(['n'])
  })

  // The semantics the per-type reads had, kept in one read (limitPerType): the
  // newest BOOT_LIMIT of EACH type. A type that floods the log fills its own
  // share and no other's — an agent rewriting notes all day cannot push an
  // older, unseen page change out of the bar.
  it('keeps BOOT_LIMIT of each type: a flood of one type evicts no change of another', async () => {
    const flood = Array.from({ length: BOOT_LIMIT * ARTIFACT_TYPES.length }, (_, i) => ev('note.updated', `n${i}`, 1000 + i))
    const { api } = fakeApi({ 'note.updated': flood, 'browser.navigated': [ev('browser.navigated', 'old-page', 10)] })
    const feed = createArtifactFeed(api, () => undefined)
    feed.start()
    await flush()
    const ids = entries(feed.get()).map((e) => e.id)
    expect(ids).toContain('old-page')
    expect(ids.filter((id) => id.startsWith('n'))).toHaveLength(BOOT_LIMIT)
    // And the endings are read back to the oldest change held, the quiet type's.
    expect(api.queryEvents).toHaveBeenNthCalledWith(2, { types: [...ENDING_TYPES], since: 10 })
  })

  it('an empty log starts at zero: everything from now on is new', async () => {
    const cutoffs: number[] = []
    createArtifactFeed(fakeApi({}).api, (at) => void cutoffs.push(at)).start()
    await flush()
    expect(cutoffs).toEqual([0])
  })

  it('a change that lands while the boot is read is not swallowed by the starting point', async () => {
    const { api, push } = fakeApi({ 'note.updated': [ev('note.updated', 'n', 50)] })
    const cutoffs: number[] = []
    const feed = createArtifactFeed(api, (at) => void cutoffs.push(at))
    feed.start()
    push(ev('note.updated', 'n', 50))
    await flush()
    expect(cutoffs).toEqual([49])
  })

  it('live events fold in, and say so', async () => {
    const { api, push } = fakeApi({})
    const feed = createArtifactFeed(api, () => undefined)
    const heard = vi.fn()
    feed.subscribe(heard)
    feed.start()
    await flush()
    push(ev('note.created', 'n', 99))
    expect(entries(feed.get()).map((e) => e.id)).toEqual(['n'])
    expect(heard).toHaveBeenCalled()
  })

  it('a boot that fails sets no starting point, and is tried again later', async () => {
    const api = { queryEvents: vi.fn(() => Promise.reject(new Error('offline'))), onEvent: vi.fn(() => () => undefined) }
    const cutoffs: number[] = []
    const retries: number[] = []
    createArtifactFeed(api, (at) => void cutoffs.push(at), (_, ms) => void retries.push(ms)).start()
    await flush()
    expect(cutoffs).toEqual([])
    expect(retries).toHaveLength(1)
  })

  it('reads the endings in one read with no limit back to the oldest change it holds; none when there is no change', async () => {
    const { api } = fakeApi({
      'note.created': [ev('note.created', 'n', 30), ev('note.created', 'm', 12)],
      'note.deleted': [ev('note.deleted', 'm', 20), ev('note.deleted', 'old', 5)]
    })
    const feed = createArtifactFeed(api, () => undefined)
    feed.start()
    await flush()
    expect(api.queryEvents).toHaveBeenCalledTimes(2)
    expect(api.queryEvents).toHaveBeenNthCalledWith(2, { types: [...ENDING_TYPES], since: 12 })
    // The ending it read back is applied: m was deleted after its change.
    expect(entries(feed.get()).map((e) => e.id)).toEqual(['n'])
    const empty = fakeApi({})
    createArtifactFeed(empty.api, () => undefined).start()
    await flush()
    expect(empty.api.queryEvents).toHaveBeenCalledTimes(1)
  })

  it('says when the boot has landed: before it, a missing card is unknown, not gone', async () => {
    const { api } = fakeApi({})
    const feed = createArtifactFeed(api, () => undefined)
    feed.start()
    expect(feed.get().ready).toBe(false)
    await flush()
    expect(feed.get().ready).toBe(true)
  })

  it('stopped (the machine was left), it hears nothing more and drops a boot still in flight', async () => {
    const { api, push } = fakeApi({ 'note.created': [ev('note.created', 'n', 10)] })
    const cutoffs: number[] = []
    const off = vi.fn()
    const feed = createArtifactFeed({ ...api, onEvent: (cb: (raw: unknown) => void) => (api.onEvent(cb), off) }, (at) => void cutoffs.push(at))
    const heard = vi.fn()
    feed.subscribe(heard)
    feed.start()
    feed.stop()
    expect(off).toHaveBeenCalled()
    expect(heard).toHaveBeenCalled()
    push(ev('note.created', 'late', 99))
    await flush()
    expect(cutoffs).toEqual([])
    expect(entries(feed.get())).toEqual([])
  })

  it('starts once', async () => {
    const { api } = fakeApi({})
    const feed = createArtifactFeed(api, () => undefined)
    feed.start()
    feed.start()
    await flush()
    expect(api.onEvent).toHaveBeenCalledTimes(1)
  })
})

describe('the rows the AGENTS group reads', () => {
  interface Row { id: string; workspaceId: string; active: boolean; phase: 'working' | 'waiting' | 'done' | 'quiet' | 'offline'; unread?: boolean; lastActivityAt: number }
  const row = (id: string, workspaceId: string, phase: Row['phase'], at: number, more: Partial<Row> = {}): Row => ({ id, workspaceId, active: true, phase, lastActivityAt: at, ...more })
  const ws = new Map<string, WorkspaceFace>([['w1', { name: 'Cookrew Dev', icon: null }], ['w2', { name: 'GOAT Team', icon: null }], ['s', { name: 'Door', icon: null, served: true }]])

  it('the open workspace from its crew, every other one from the roster, once each', () => {
    const open = [row('a', 'w1', 'waiting', 10)]
    const all = [row('a', 'w1', 'waiting', 10), row('b', 'w2', 'waiting', 20)]
    expect(inboxRows(open, all, 'w1', ws).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('a served workspace is left out, open or not; so is one the list does not know, and a stopped agent', () => {
    const all = [row('s1', 's', 'waiting', 10), row('x', 'nowhere', 'waiting', 10), row('off', 'w2', 'done', 10, { unread: true, active: false })]
    expect(inboxRows([], all, 'w1', ws)).toEqual([])
    expect(inboxRows([row('s1', 's', 'waiting', 10)], [], 's', ws)).toEqual([])
  })

  it('ordered by urgency and time, not by workspace', () => {
    const rows = inboxRows([row('a', 'w1', 'done', 50, { unread: true })], [row('b', 'w2', 'waiting', 10), row('c', 'w2', 'waiting', 30)], 'w1', ws)
    expect(agentInbox(rows).map((e) => `${e.id}:${e.why}`)).toEqual(['c:waiting', 'b:waiting', 'a:reply'])
  })

  it("another workspace's mark: its icon, else its name's first letter", () => {
    expect(badgeOf({ name: 'GOAT Team', icon: '🐐' })).toBe('🐐')
    expect(badgeOf({ name: 'solis', icon: null })).toBe('S')
    expect(badgeOf({ name: '', icon: '  ' })).toBe('?')
    expect(badgeOf(undefined)).toBe('?')
  })

  it('the second tap: the full view here, the jump from anywhere else', () => {
    expect(secondTap('w1', 'w1')).toBe('full')
    expect(secondTap('w2', 'w1')).toBe('jump')
  })
})

describe("a card from another workspace is read-only", () => {
  it('it never becomes the agent the prompt box carries', () => {
    barCard.open({ kind: 'agent', id: 'far', away: true })
    expect(barCard.agent()).toBeNull()
    barCard.open({ kind: 'agent', id: 'near' })
    expect(barCard.agent()).toBe('near')
    barCard.close()
  })
})

describe('the wiring', () => {
  const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')
  const groups = read('zoom', 'BarGroups.tsx')
  const view = read('zoom', 'ZoomView.tsx')
  it('the groups read every workspace: the crew for agents, the log for artifacts', () => {
    expect(groups).toMatch(/inboxRows\(/)
    expect(groups).toMatch(/useArtifacts\(\)/)
    expect(groups).toMatch(/artifactInbox\(/)
    expect(groups).not.toMatch(/itemSig|barSeen\.observe/)
  })
  it('another workspace is reached by the app’s own jump', () => {
    expect(groups).toMatch(/onJump\(/)
    expect(view).toMatch(/jumpToNode/)
  })
})
