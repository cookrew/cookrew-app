import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compactStampOf,
  inheritsCompactionOf,
  resolveRotationChain,
  rotationCommitVerdict,
  rotationEdgeOf,
  type RotationFs,
  type SessionFileEntry
} from '../src/main/claude-rotation'
import { liveSessionHolders, type LiveSessionFs } from '../src/main/claude-live-session'
import { liveSessionOfPane, oracleVerdict, PanePidCache } from '../src/main/claude-session-oracle'

/**
 * THE CHECKPOINT ⇔ LIVE-TRANSCRIPT GATE — permanent.
 *
 * The rail, the drawer and every checkpoint a card shows are read from the
 * session file the node is bound to. The terminal is driven by a process
 * that writes wherever claude decided to write. When those two disagree the
 * card lies: a live transcript under a rail frozen at some earlier hour. It
 * has happened three times (2026-07-21 reboot, 2026-08-14 context rotation,
 * 2026-09-05 resume replay), each time through a shape the directory
 * inference could not read. This gate pins the invariant at its root and
 * the two inference defects found on 2026-09-05:
 *
 *   G1  the pane's process is the authority while it lives
 *       (~/.claude/sessions/<pid>.json → claudeSessionId)
 *   G2  a successor that REPLAYS its predecessor's compaction pair is not a
 *       successor of the grandparent
 *   G3  the commit is refused when the live session belongs to another card
 *
 * The live half is scripts/checkpoint-live-gate.mjs, which asks the same
 * question of every running card. Run it whenever the rail looks stale.
 */

const GRANDPARENT = '5880c754-faf9-460e-89eb-7345e4f9bcd8'
const BOUND = '5a4cdb91-93ba-40fa-95e6-42e044313459'
const LIVE = 'f16cf111-da9b-4231-a57b-2a0ed8cccb49'
const STRANGER = '0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d'
const CWD = '/Users/drej/workspace/cookrew-dev'
const STAMP = '2026-09-03T05:29:39.411Z'

const uuid = (n: number): string => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`

/** claude's compaction pair, as the successor REPLAYS it: own sid, old stamp. */
function compactPair(own: string, predecessor: string, stamp = STAMP): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      logicalParentUuid: 'a3008b63-5d8f-4473-a4ff-b13198f55347',
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 785365,
        postTokens: 13978
      },
      sessionId: own,
      cwd: CWD,
      timestamp: '2026-09-03T05:29:40.692Z'
    }),
    JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      uuid: uuid(1),
      message: { role: 'user', content: 'This session is being continued…' },
      sessionId: own,
      session_id: predecessor,
      cwd: CWD,
      timestamp: stamp
    })
  ]
}

function conversation(own: string, from: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      type: (from + i) % 2 === 0 ? 'user' : 'assistant',
      uuid: uuid(from + i),
      message: { role: 'user', content: `turn ${from + i}` },
      sessionId: own,
      cwd: CWD
    })
  )
}

/** The bound file as measured: chrome, ITS compaction pair, its turns. */
const boundHead = [
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId: BOUND }),
  ...compactPair(BOUND, GRANDPARENT),
  ...conversation(BOUND, 2, 40)
]

/** The live successor as measured: chrome, the REPLAYED pair, the replayed turns. */
const liveHead = [
  JSON.stringify({ type: 'custom-title', sessionId: LIVE }),
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId: LIVE }),
  ...compactPair(LIVE, GRANDPARENT),
  ...conversation(LIVE, 2, 40)
]

interface FakeFile {
  sessionId: string
  head: string[]
  mtimeMs: number
}

function fakeFs(files: readonly FakeFile[]): RotationFs {
  const heads = new Map(files.map((f) => [f.sessionId, f.head]))
  return {
    listSessions: (dir): Promise<SessionFileEntry[]> =>
      Promise.resolve(
        files.map((f) => ({
          file: path.join(dir, `${f.sessionId}.jsonl`),
          sessionId: f.sessionId,
          mtimeMs: f.mtimeMs,
          size: 100
        }))
      ),
    readHead: (file) => Promise.resolve(heads.get(path.basename(file, '.jsonl')) ?? [])
  }
}

describe('G2 — a replayed compaction pair is inherited, not declared', () => {
  it('reads the pair as an edge on its own (the shape is byte-identical)', () => {
    expect(rotationEdgeOf(liveHead)).toEqual({
      sessionId: LIVE,
      predecessorId: GRANDPARENT,
      cwd: CWD
    })
    expect(compactStampOf(liveHead)).toBe(STAMP)
  })

  it('tells an inherited pair from an own one by predecessor AND stamp', () => {
    expect(inheritsCompactionOf(liveHead, boundHead)).toBe(true)
    // Same predecessor, a different compaction: a genuine sibling.
    const sibling = [...compactPair(STRANGER, GRANDPARENT, '2026-09-04T01:00:00.000Z')]
    expect(inheritsCompactionOf(sibling, boundHead)).toBe(false)
    // A head with no pair inherits nothing.
    expect(inheritsCompactionOf(conversation(LIVE, 2, 10), boundHead)).toBe(false)
  })

  it('resolves the bound session to the live successor — the 2026-09-05 shape', async () => {
    const chain = await resolveRotationChain({
      cwd: CWD,
      sessionId: BOUND,
      projectsDir: '/tmp/gate-projects',
      fs: fakeFs([
        {
          sessionId: GRANDPARENT,
          head: conversation(GRANDPARENT, 0, 12),
          mtimeMs: 1_000
        },
        { sessionId: BOUND, head: boundHead, mtimeMs: 2_000 },
        { sessionId: LIVE, head: liveHead, mtimeMs: 3_000 }
      ])
    })
    expect(chain).toEqual([LIVE])
  })

  it('still refuses a genuine compaction successor of ANOTHER session', async () => {
    // A stranger's compaction that happens to name the same grandparent at a
    // different moment is judged by its declaration and never adopted.
    const strangerHead = [
      ...compactPair(STRANGER, GRANDPARENT, '2026-09-04T01:00:00.000Z'),
      ...conversation(STRANGER, 500, 40)
    ]
    const chain = await resolveRotationChain({
      cwd: CWD,
      sessionId: BOUND,
      projectsDir: '/tmp/gate-projects',
      fs: fakeFs([
        { sessionId: BOUND, head: boundHead, mtimeMs: 2_000 },
        { sessionId: STRANGER, head: strangerHead, mtimeMs: 3_000 }
      ])
    })
    expect(chain).toBeNull()
  })
})

/** Shape-accurate ~/.claude/sessions/<pid>.json records (claude 2.1.258). */
function sessionsFs(records: Record<number, object>, alive: number[]): LiveSessionFs {
  const files = Object.fromEntries(
    Object.entries(records).map(([pid, body]) => [`${pid}.json`, JSON.stringify(body)])
  )
  return {
    list: () => Object.keys(files),
    read: (file) => {
      const body = files[path.basename(file)]
      if (body === undefined) throw new Error('ENOENT')
      return body
    },
    alive: (pid) => alive.includes(pid)
  }
}

describe('G1 — the pane process is the authority while it lives', () => {
  const holders = liveSessionHolders(
    '/tmp/sessions',
    sessionsFs(
      {
        84516: {
          pid: 84516,
          sessionId: LIVE,
          cwd: CWD,
          kind: 'interactive',
          status: 'busy'
        },
        84724: {
          pid: 84724,
          sessionId: STRANGER,
          cwd: CWD,
          kind: 'interactive'
        },
        92878: { pid: 92878, sessionId: BOUND, cwd: CWD, kind: 'bg' },
        70000: {
          pid: 70000,
          sessionId: LIVE,
          cwd: '/somewhere/else',
          kind: 'interactive'
        }
      },
      [84516, 84724, 92878, 70000]
    )
  )
  const real = (dir: string): string => dir

  it('joins the pane pid to the session its process reports', () => {
    expect(liveSessionOfPane(84516, holders, CWD, real)).toEqual({
      pid: 84516,
      sessionId: LIVE
    })
  })

  it('says nothing without a pid, a record, or for a background holder', () => {
    expect(liveSessionOfPane(null, holders, CWD, real)).toBeNull()
    expect(liveSessionOfPane(11111, holders, CWD, real)).toBeNull()
    expect(liveSessionOfPane(92878, holders, CWD, real)).toBeNull()
  })

  it('refuses a record whose cwd is not this terminal (a reused pid)', () => {
    expect(liveSessionOfPane(70000, holders, CWD, real)).toBeNull()
  })

  it('the verdict: agree, rebind, and refuse to cross-wire', () => {
    const live = { pid: 84516, sessionId: LIVE }
    expect(oracleVerdict(LIVE, live, new Set())).toBe('agree')
    expect(oracleVerdict(BOUND, live, new Set())).toBe('rebind')
    expect(oracleVerdict(BOUND, null, new Set())).toBe('no-answer')
  })

  it('a pane pid is looked up once per pane lifetime and again after it dies', () => {
    const alive = new Set([84516])
    let clock = 0
    let lookups = 0
    const cache = new PanePidCache(
      () => {
        lookups++
        return alive.has(84516) ? 84516 : alive.has(90000) ? 90000 : null
      },
      (pid) => alive.has(pid),
      () => clock,
      25_000
    )
    expect(cache.isWarm('t')).toBe(false)
    expect(cache.pidOf('t')).toBe(84516)
    expect(cache.pidOf('t')).toBe(84516)
    expect(cache.isWarm('t')).toBe(true)
    expect(lookups).toBe(1)
    alive.delete(84516)
    expect(cache.isWarm('t')).toBe(false)
    expect(cache.pidOf('t')).toBeNull()
    // The respawned pane is found once the miss has aged out.
    alive.add(90000)
    clock = 30_000
    expect(cache.pidOf('t')).toBe(90000)
    expect(lookups).toBe(3)
  })

  it('a miss is remembered for the TTL — no herdr call per sweep for a gone pane', () => {
    let clock = 0
    let lookups = 0
    const cache = new PanePidCache(
      () => {
        lookups++
        return null
      },
      () => true,
      () => clock,
      25_000
    )
    expect(cache.pidOf('t')).toBeNull()
    expect(cache.pidOf('t')).toBeNull()
    expect(cache.isWarm('t')).toBe(true)
    expect(lookups).toBe(1)
    clock = 26_000
    expect(cache.isWarm('t')).toBe(false)
    expect(cache.pidOf('t')).toBeNull()
    expect(lookups).toBe(2)
    cache.forget('t')
    expect(cache.pidOf('t')).toBeNull()
    expect(lookups).toBe(3)
  })
})

describe('G3 — a live session another card owns is never adopted', () => {
  it('the oracle verdict refuses it', () => {
    expect(oracleVerdict(BOUND, { pid: 84516, sessionId: LIVE }, new Set([LIVE]))).toBe('claimed')
  })

  it('and the commit re-reads the store after the last await', () => {
    expect(
      rotationCommitVerdict({
        boundBefore: BOUND,
        boundNow: BOUND,
        chain: [LIVE],
        claimed: new Set([LIVE])
      })
    ).toBe('claimed')
    expect(
      rotationCommitVerdict({
        boundBefore: BOUND,
        boundNow: BOUND,
        chain: [LIVE],
        claimed: new Set()
      })
    ).toBe('commit')
  })
})
