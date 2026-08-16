// Mid-flight Claude session rotation: following a conversation that moved to
// a new session file with no respawn, no adopt event and no exit.
//
// The fixtures below are the SHAPE probed on the confirmed rotation
// (claude 2.1.222): a `compact_boundary` system record rooting the new file,
// then a continuation summary whose `sessionId` is the new session and whose
// `session_id` is the old one. Everything the detector believes comes from
// that pair; everything else it refuses.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ROTATION_CANDIDATE_CAP,
  ROTATION_MTIME_SLACK_MS,
  readHeadLines,
  resolveRotationChain,
  rotationCommitVerdict,
  rotationEdgeOf,
  type RotationFs,
  type SessionFileEntry
} from '../src/main/claude-rotation'
import { withSessionLineage } from '../src/main/session-lineage'
import { claudeProjectSlug } from '../src/shared/claude-fork'

const OLD = 'dfa97c83-63fb-4a37-9b50-ef19c1c6069f'
const NEW = '32c018ac-08ca-42d8-8284-8dbb6e0075c4'
const THIRD = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-8888-4777-8666-555555555555'
const CWD = '/w/proj'

function boundary(own: string): string {
  return JSON.stringify({
    parentUuid: null,
    logicalParentUuid: '290fc341-7f8b-4c59-aec5-2f662fdec1f7',
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 264058, postTokens: 13020 },
    sessionId: own,
    cwd: CWD
  })
}

function summary(own: string, predecessor: string, cwd = CWD): string {
  return JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous…' },
    sessionId: own,
    session_id: predecessor,
    cwd,
    timestamp: '2026-08-14T00:47:04.701Z'
  })
}

/** The head claude actually writes: chrome, then the boundary/summary pair. */
function rotationHead(own: string, predecessor: string, cwd = CWD): string[] {
  return [
    JSON.stringify({ type: 'ai-title', aiTitle: 'work', sessionId: own }),
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: own }),
    boundary(own),
    summary(own, predecessor, cwd)
  ]
}

/** An ordinary conversation head — no rotation anywhere in it. */
function plainHead(own: string): string[] {
  return [
    JSON.stringify({ type: 'ai-title', aiTitle: 'work', sessionId: own }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      sessionId: own,
      session_id: own
    })
  ]
}

interface FakeFile {
  sessionId: string
  head: string[]
  mtimeMs?: number
}

/**
 * The seam is async, and these fakes resolve on a MACROtask (setTimeout 0),
 * not merely on a resolved promise: a fake that never leaves the microtask
 * queue would let a scan that still blocks the thread pass its own test.
 */
function fakeFs(files: readonly FakeFile[]): RotationFs {
  const heads = new Map(files.map((f) => [f.sessionId, f.head]))
  return {
    listSessions: (dir): Promise<SessionFileEntry[]> =>
      later(
        files.map((f, i) => ({
          file: path.join(dir, `${f.sessionId}.jsonl`),
          sessionId: f.sessionId,
          mtimeMs: f.mtimeMs ?? 1000 + i,
          size: 100
        }))
      ),
    readHead: (file) => later(heads.get(path.basename(file, '.jsonl')) ?? [])
  }
}

function later<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0))
}

/**
 * THE RESUME SHAPE, as measured on Conductor's own terminal: bound 32c018ac
 * went stale at T39 while f8cf0774 was live, and the successor's head carried
 * ai-title / agent-name / mode records and NOTHING else — no compact_boundary,
 * no isCompactSummary. The edge is the replay: all 375 of the successor's head
 * message uuids already existed in the predecessor.
 */
function replayUuid(n: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`
}

/** A conversation's own records, with the uuids a resume will replay. */
function conversation(own: string, count: number, cwd = CWD): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: replayUuid(i),
      parentUuid: i === 0 ? null : replayUuid(i - 1),
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` },
      sessionId: own,
      cwd
    })
  )
}

/**
 * What `claude --resume` writes: its own metadata records, then the
 * predecessor's records replayed VERBATIM — original uuids, and (because they
 * are the predecessor's records) the PREDECESSOR's sessionId. The successor's
 * only statement of its own identity is its file name.
 */
function resumeHead(predecessor: string, count: number, cwd = CWD): string[] {
  return [
    JSON.stringify({ type: 'ai-title', aiTitle: 'work' }),
    JSON.stringify({ type: 'agent-name', name: 'Conductor' }),
    JSON.stringify({ type: 'mode', mode: 'normal' }),
    ...conversation(predecessor, count, cwd)
  ]
}

describe('rotationEdgeOf — the successor states its predecessor', () => {
  it('reads the predecessor off a real rotation head', () => {
    expect(rotationEdgeOf(rotationHead(NEW, OLD))).toEqual({
      sessionId: NEW,
      predecessorId: OLD,
      cwd: CWD
    })
  })

  it('finds the pair past a 200KB file-history-snapshot line', () => {
    // Session heads carry snapshot records of hundreds of KB; the prefilter
    // must skip them without ever failing to reach the records that matter.
    const fat = JSON.stringify({ type: 'file-history-snapshot', snapshot: 'x'.repeat(200_000) })
    const lines = [fat, ...rotationHead(NEW, OLD), fat]
    expect(rotationEdgeOf(lines)?.predecessorId).toBe(OLD)
  })

  it('says nothing about an in-file compaction (same session, compacted in place)', () => {
    // Both ids equal: the conversation compacted WITHOUT rotating. Reporting
    // an edge here would rebind a terminal onto the file it is already on.
    expect(rotationEdgeOf([boundary(NEW), summary(NEW, NEW)])).toBeNull()
  })

  it('refuses a continuation summary with no boundary before it', () => {
    // A summary on its own is a fragment (a truncated copy, a hand edit), not
    // evidence that a live session moved here.
    expect(rotationEdgeOf([summary(NEW, OLD)])).toBeNull()
  })

  it('refuses a predecessor id that is not UUID-shaped', () => {
    expect(rotationEdgeOf([boundary(NEW), summary(NEW, '../../etc/passwd')])).toBeNull()
  })

  it('reports nothing for an ordinary conversation head', () => {
    expect(rotationEdgeOf(plainHead(NEW))).toBeNull()
  })
})

describe('resolveRotationChain — rotation detection', () => {
  it('follows the bound session to its successor', async () => {
    const chain = await resolveRotationChain({
      cwd: CWD,
      sessionId: OLD,
      fs: fakeFs([
        { sessionId: OLD, head: plainHead(OLD) },
        { sessionId: NEW, head: rotationHead(NEW, OLD) }
      ])
    })
    expect(chain).toEqual([NEW])
  })

  it('follows several rotations the app was blind across, oldest hop first', async () => {
    const chain = await resolveRotationChain({
      cwd: CWD,
      sessionId: OLD,
      fs: fakeFs([
        { sessionId: OLD, head: plainHead(OLD) },
        { sessionId: NEW, head: rotationHead(NEW, OLD) },
        { sessionId: THIRD, head: rotationHead(THIRD, NEW) }
      ])
    })
    expect(chain).toEqual([NEW, THIRD])
  })

  it('stays put when the file is merely quiet and nothing claims it', async () => {
    // The ordinary case by far: a long tool call, not a rotation.
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: plainHead(NEW) }
        ])
      })
    ).resolves.toBeNull()
  })

  it('stays put when the bound session has no file in the project dir', async () => {
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([{ sessionId: NEW, head: rotationHead(NEW, OLD) }])
      })
    ).resolves.toBeNull()
  })

  it('ignores a claimant far older than the file that went quiet', async () => {
    // A successor is being written while its predecessor is frozen, so it is
    // never meaningfully older. A stale copy claiming the same parent is not
    // the live conversation.
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD), mtimeMs: 10_000_000 },
          {
            sessionId: NEW,
            head: rotationHead(NEW, OLD),
            mtimeMs: 10_000_000 - ROTATION_MTIME_SLACK_MS - 1
          }
        ])
      })
    ).resolves.toBeNull()
  })
})

describe('resolveRotationChain — refusal on ambiguity', () => {
  it('refuses when TWO files claim the same predecessor', async () => {
    // A native fork copy alongside the real successor, or a session resumed
    // twice and compacted twice. Either way nothing on disk says which one
    // the pane is running: a wrong file is worse than a stale one.
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD) },
          { sessionId: THIRD, head: rotationHead(THIRD, OLD) }
        ])
      })
    ).resolves.toBeNull()
  })

  it('refuses the WHOLE chain when a later hop is ambiguous', async () => {
    // Stopping at the last unambiguous hop would bind the node to a file that
    // is itself dead — a quieter version of the same bug.
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD) },
          { sessionId: THIRD, head: rotationHead(THIRD, NEW) },
          { sessionId: OTHER, head: rotationHead(OTHER, NEW) }
        ])
      })
    ).resolves.toBeNull()
  })

  it('refuses a head whose own session id disagrees with its filename', async () => {
    // A copied/renamed file. Its name is its identity; a head that contradicts
    // it has been rewritten and is not evidence of anything.
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(THIRD, OLD) }
        ])
      })
    ).resolves.toBeNull()
  })

  it('refuses a claimant stamped with a different working directory', async () => {
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD, '/w/somewhere-else') }
        ])
      })
    ).resolves.toBeNull()
  })

  it('refuses a session id that is not UUID-shaped before touching the disk', async () => {
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: '../../../etc/passwd',
        fs: {
          listSessions: () => {
            throw new Error('must not scan for an unusable id')
          },
          readHead: () => later([])
        }
      })
    ).resolves.toBeNull()
  })
})

describe('resolveRotationChain — 1:1 ownership', () => {
  it('never adopts a session another node is bound to', async () => {
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        claimed: new Set([NEW]),
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD) }
        ])
      })
    ).resolves.toBeNull()
  })

  it('never adopts a session that is an earlier segment of another node', async () => {
    // Another node's lineage is still its history; taking one cross-wires two
    // rails, which is the failure the codex/pi binds guard the same way.
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        claimed: new Set([THIRD]),
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD) },
          { sessionId: THIRD, head: rotationHead(THIRD, NEW) }
        ])
      })
    ).resolves.toBeNull()
  })

  it('adopts an unowned successor while other nodes hold their own sessions', async () => {
    const chain = await resolveRotationChain({
      cwd: CWD,
      sessionId: OLD,
      claimed: new Set([OTHER]),
      fs: fakeFs([
        { sessionId: OLD, head: plainHead(OLD) },
        { sessionId: NEW, head: rotationHead(NEW, OLD) },
        { sessionId: OTHER, head: plainHead(OTHER) }
      ])
    })
    expect(chain).toEqual([NEW])
  })
})

describe('resolveRotationChain — on a real project directory', () => {
  it('finds the successor by reading only the head of a large session file', async () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-rotation-'))
    const dir = path.join(projectsDir, claudeProjectSlug(CWD))
    mkdirSync(dir, { recursive: true })
    // The predecessor: big, and frozen.
    const bulk = Array.from({ length: 200 }, () =>
      JSON.stringify({ type: 'assistant', sessionId: OLD, message: { content: 'x'.repeat(2000) } })
    )
    writeFileSync(path.join(dir, `${OLD}.jsonl`), [...plainHead(OLD), ...bulk].join('\n') + '\n')
    // The successor: a realistic head — chrome, a 300KB snapshot line, then
    // the boundary/summary pair — followed by the live conversation.
    const snapshot = JSON.stringify({ type: 'file-history-snapshot', snapshot: 'y'.repeat(300_000) })
    writeFileSync(
      path.join(dir, `${NEW}.jsonl`),
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'work', sessionId: NEW }),
        snapshot,
        boundary(NEW),
        summary(NEW, OLD),
        ...bulk
      ].join('\n') + '\n'
    )
    // An unrelated neighbour in the same project dir must not be picked up.
    writeFileSync(path.join(dir, `${OTHER}.jsonl`), plainHead(OTHER).join('\n') + '\n')

    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, projectsDir })).resolves.toEqual([
      NEW
    ])
  })

  it('reads nothing and reports nothing when the project dir does not exist', async () => {
    await expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        projectsDir: path.join(tmpdir(), 'cookrew-rotation-absent')
      })
    ).resolves.toBeNull()
  })

  it('opens at most ROTATION_CANDIDATE_CAP candidates, plus the bound file, per probe', async () => {
    const files: FakeFile[] = Array.from({ length: 40 }, (_, i) => ({
      sessionId: `0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`,
      head: plainHead('x'),
      mtimeMs: 10_000 - i
    }))
    const opened: string[] = []
    const fs = fakeFs([{ sessionId: OLD, head: plainHead(OLD), mtimeMs: 10_000 }, ...files])
    await resolveRotationChain({
      cwd: CWD,
      sessionId: OLD,
      fs: { ...fs, readHead: (file) => (opened.push(file), fs.readHead(file)) }
    })
    // CAP candidates, each opened EXACTLY ONCE (one wide head serves both the
    // declared and the replay shape), plus the bound file — whose own uuids
    // are what a replay is compared against, and which is never a candidate
    // for its own succession. Still an exact bound, one file wider.
    expect(new Set(opened).size).toBe(opened.length)
    expect(opened).toHaveLength(ROTATION_CANDIDATE_CAP + 1)
  })

  // D10: the probe used to do this with readSync on the Electron MAIN thread —
  // up to ROTATION_CANDIDATE_CAP × ROTATION_HEAD_BYTES (~16MB) of blocking
  // reads on the thread that also serves IPC, PTY writes and the window's own
  // frames, every time a busy pane went quiet. It must now yield.
  it('never blocks the thread it runs on: a timer queued after it runs first', async () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-rotation-yield-'))
    const dir = path.join(projectsDir, claudeProjectSlug(CWD))
    mkdirSync(dir, { recursive: true })
    // Heads big enough that a synchronous reader would be plainly visible.
    const bulk = Array.from({ length: 400 }, () =>
      JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4000) } })
    )
    for (let i = 0; i < ROTATION_CANDIDATE_CAP; i += 1) {
      const id = `0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`
      writeFileSync(path.join(dir, `${id}.jsonl`), [...plainHead(id), ...bulk].join('\n') + '\n')
    }
    writeFileSync(path.join(dir, `${OLD}.jsonl`), [...plainHead(OLD), ...bulk].join('\n') + '\n')

    const order: string[] = []
    const scan = resolveRotationChain({ cwd: CWD, sessionId: OLD, projectsDir }).then(() =>
      order.push('scan')
    )
    // Queued AFTER the call, so under the old blocking reader it could only
    // ever run once the whole scan had finished.
    const interleaved = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('timer')
        resolve()
      }, 0)
    )
    await Promise.all([scan, interleaved])
    expect(order).toEqual(['timer', 'scan'])
  })
})

// ---- real data: the rotations this machine has actually recorded ----
//
// The detector reads a shape claude writes, so the corpus that matters is the
// one on disk. These assert SOUNDNESS (never a claim that cannot be true)
// rather than a fixed expected answer, which would rot the moment a session
// file is cleaned up. They also run the byte-capped head reader over hundreds
// of real files, including multi-hundred-MB ones.
describe('rotation detection on REAL session files', () => {
  function projectDirs(): string[] {
    const root = path.join(homedir(), '.claude', 'projects')
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
  }

  interface RealEdge {
    dir: string
    file: string
    sessionId: string
    predecessorId: string
  }

  async function realEdges(): Promise<RealEdge[]> {
    const files = projectDirs().flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => ({ dir, file: path.join(dir, name) }))
    )
    const edges = await Promise.all(
      files.map(async ({ dir, file }) => {
        const edge = rotationEdgeOf(await readHeadLines(file))
        return edge === null
          ? []
          : [{ dir, file, sessionId: edge.sessionId, predecessorId: edge.predecessorId }]
      })
    )
    return edges.flat()
  }

  it('never claims a file continues itself, or continues a session it is not', async () => {
    const edges = await realEdges()
    if (edges.length === 0) return // no rotation on this machine yet
    for (const edge of edges) {
      // The file's name is its identity; a head that disagrees is a copy.
      expect(path.basename(edge.file, '.jsonl')).toBe(edge.sessionId)
      expect(edge.predecessorId).not.toBe(edge.sessionId)
    }
  })

  it('follows every recorded rotation to that exact successor, or refuses', async () => {
    const edges = await realEdges()
    if (edges.length === 0) return
    for (const edge of edges) {
      // The scan works from a terminal's cwd; the project dir is derived from
      // it, so ask the question the way the app asks it.
      const cwd = await cwdOfSession(edge.file)
      if (cwd === null) continue
      const chain = await resolveRotationChain({ cwd, sessionId: edge.predecessorId })
      // Refusal is always allowed (ambiguity, liveness, ownership). Landing
      // somewhere OTHER than the successor the file itself names is not.
      if (chain !== null) expect(chain[0]).toBe(edge.sessionId)
    }
  })
})

/** The cwd a session file stamps on its records, read from its head. */
async function cwdOfSession(file: string): Promise<string | null> {
  for (const line of await readHeadLines(file)) {
    try {
      const record = JSON.parse(line) as { cwd?: string }
      if (typeof record.cwd === 'string') return record.cwd
    } catch {
      continue
    }
  }
  return null
}

// The other half of D10: with the SCAN off-thread, everything it believed can
// have changed by the time it answers, so the commit re-reads the store after
// the last await and lands in one JS turn. These are that re-check.
describe('rotationCommitVerdict — the synchronous-commit invariant', () => {
  const unclaimed = new Set<string>()

  it('commits a chain whose premises still hold', () => {
    expect(
      rotationCommitVerdict({
        boundBefore: OLD,
        boundNow: OLD,
        chain: [NEW],
        claimed: unclaimed
      })
    ).toBe('commit')
  })

  it('refuses when the node was rebound while the probe was reading', () => {
    // recover, a fork, a hand edit, or another probe: the answer describes a
    // conversation this terminal has left, so it is dropped — never re-aimed
    // at whatever the node moved to.
    expect(
      rotationCommitVerdict({
        boundBefore: OLD,
        boundNow: THIRD,
        chain: [NEW],
        claimed: unclaimed
      })
    ).toBe('binding-moved')
  })

  it('refuses when the binding vanished under the probe (node killed/cleared)', () => {
    expect(
      rotationCommitVerdict({
        boundBefore: OLD,
        boundNow: undefined,
        chain: [NEW],
        claimed: unclaimed
      })
    ).toBe('binding-moved')
  })

  it('refuses when another node claimed the successor mid-probe', () => {
    expect(
      rotationCommitVerdict({
        boundBefore: OLD,
        boundNow: OLD,
        chain: [NEW],
        claimed: new Set([NEW])
      })
    ).toBe('claimed')
  })

  it('refuses when a peer claimed an EARLIER hop, not just the last one', () => {
    // The whole chain lands on this node's lineage, so an intermediate hop
    // owned by a peer cross-wires two rails exactly as its live binding would.
    // A last-hop-only ownership check (isRefOwned) passes this case.
    expect(
      rotationCommitVerdict({
        boundBefore: OLD,
        boundNow: OLD,
        chain: [NEW, THIRD],
        claimed: new Set([NEW])
      })
    ).toBe('claimed')
  })

  it('refuses an empty chain — there is nothing to bind to', () => {
    expect(
      rotationCommitVerdict({ boundBefore: OLD, boundNow: OLD, chain: [], claimed: unclaimed })
    ).toBe('empty-chain')
  })
})

// The rail's contract for a rebind (session-lineage): the node moves to the
// live session and EVERY id it passed through stays behind a clear marker,
// so earlier segments remain visible and cross-clear rewind can cut into them.
describe('rotation chain folded onto the session lineage', () => {
  it('appends every hop, ending bound to the live session', () => {
    const node = { claudeSessionId: OLD, sessionLineage: ['grandparent'] }
    const patch = [NEW, THIRD].reduce(withSessionLineage, node)
    expect(patch.claudeSessionId).toBe(THIRD)
    expect(patch.sessionLineage).toEqual(['grandparent', OLD, NEW])
  })

  it('records the transition on a node that had no lineage yet', () => {
    const patch = [NEW].reduce(withSessionLineage, {
      claudeSessionId: OLD,
      sessionLineage: undefined
    })
    expect(patch).toEqual({ claudeSessionId: NEW, sessionLineage: [OLD] })
  })
})

describe('resolveRotationChain — the RESUME shape (crash recovery)', () => {
  const RESUMED = 'f8cf0774-1111-4222-8333-444444444444'

  it('follows a resume rotation that declares nothing — the Conductor case', async () => {
    // Bound file went stale; the live file carries no compact provenance at
    // all, only the predecessor's records replayed under a new name.
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 20), mtimeMs: 2000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toEqual([
      RESUMED
    ])
  })

  it('refuses a fresh unrelated session — zero shared uuids', async () => {
    const fresh = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        uuid: `eeeeeeee-ffff-4aaa-8bbb-${String(i).padStart(12, '0')}`,
        message: { role: 'user', content: 'unrelated' },
        sessionId: NEW,
        cwd: CWD
      })
    )
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: NEW, head: fresh, mtimeMs: 2000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toBeNull()
  })

  it('refuses a replay too short to be evidence', async () => {
    // Below ROTATION_RESUME_MIN_UUIDS: a handful of shared ids is a
    // coincidence budget no rebind should spend.
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 4), mtimeMs: 1000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 4), mtimeMs: 2000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toBeNull()
  })

  it('refuses when a session was resumed TWICE — two files replay the same records', async () => {
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 20), mtimeMs: 2000 },
      { sessionId: THIRD, head: resumeHead(OLD, 20), mtimeMs: 2100 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toBeNull()
  })

  it('refuses a replay stamped with another terminal’s cwd', async () => {
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 20, '/w/elsewhere'), mtimeMs: 2000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toBeNull()
  })

  it('never adopts a hop another node already owns', async () => {
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 20), mtimeMs: 2000 }
    ])
    await expect(
      resolveRotationChain({ cwd: CWD, sessionId: OLD, fs, claimed: new Set([RESUMED]) })
    ).resolves.toBeNull()
  })

  it('prefers the DECLARED successor when both shapes are present', async () => {
    // A compaction successor names OLD outright; a second file merely replays
    // OLD's records. claude's own statement wins over the inference.
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: NEW, head: [...rotationHead(NEW, OLD), ...conversation(NEW, 2)], mtimeMs: 2000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 20), mtimeMs: 2100 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toEqual([NEW])
  })

  it('will not read a file that names a DIFFERENT predecessor as a replay of this one', async () => {
    // THIRD is a compaction successor of OTHER, and its head therefore carries
    // OTHER's replayed records. Matching it here would cross two chains.
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      {
        sessionId: THIRD,
        head: [...rotationHead(THIRD, OTHER), ...conversation(OLD, 20)],
        mtimeMs: 2000
      }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toBeNull()
  })

  // Sol round-2 P0: the overlap operands are DIRECTIONAL — the denominator is
  // the CANDIDATE's head, and every replayed record it opens with must
  // already exist in the predecessor. The original fixtures were symmetric
  // (20-vs-20), which passes with the operands reversed too; these two are
  // asymmetric on purpose and pin the direction.
  it('refuses a candidate holding the predecessor PLUS unrelated history (superset-with-noise)', async () => {
    // OLD's whole head is 8 records; the candidate replays all 8 — and then
    // carries 12 records OLD never had. Reversed operands score this 8/8 and
    // rebind the terminal onto a mostly foreign conversation; the intended
    // proof scores 8/20 and refuses.
    const foreign = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        uuid: `bbbbbbbb-cccc-4ddd-8eee-${String(i).padStart(12, '0')}`,
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `foreign ${i}` },
        sessionId: RESUMED,
        cwd: CWD
      })
    )
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 8), mtimeMs: 1000 },
      { sessionId: RESUMED, head: [...resumeHead(OLD, 8), ...foreign], mtimeMs: 2000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toBeNull()
  })

  it('accepts a SUBSET replay — a candidate whose whole head lives inside a longer predecessor', async () => {
    // The predecessor holds 20 records; the resume replayed only the first 8
    // (still >= ROTATION_RESUME_MIN_UUIDS). Every candidate head uuid exists
    // in the predecessor, so the intended proof scores 8/8 and accepts;
    // reversed operands score 8/20 and wrongly refuse a real rotation.
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: RESUMED, head: resumeHead(OLD, 8), mtimeMs: 2000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toEqual([
      RESUMED
    ])
  })

  it('follows a MIXED chain: a compaction, then a crash recovery', async () => {
    const fs = fakeFs([
      { sessionId: OLD, head: conversation(OLD, 20), mtimeMs: 1000 },
      { sessionId: NEW, head: [...rotationHead(NEW, OLD), ...conversation(NEW, 20)], mtimeMs: 2000 },
      { sessionId: RESUMED, head: resumeHead(NEW, 20), mtimeMs: 3000 }
    ])
    await expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, fs })).resolves.toEqual([
      NEW,
      RESUMED
    ])
  })
})

describe('the successor probe runs at SPAWN/ADOPT, not only when a pane goes quiet', () => {
  const indexSource = readFileSync('src/main/index.ts', 'utf8')

  it('is wired into the spawn path for every bound claude terminal', () => {
    // A crash-recovery rotation happens while there is NO pane: the process
    // dies, claude resumes under a new id, and the staleness watcher — which
    // needs a pane in a turn going quiet — can never see it. Measured live:
    // f8cf0774 -> cf006c7e sat undetected until the binding was repointed by
    // hand, because resolveClaudeSessionId keeps a stored id whose file merely
    // EXISTS without ever asking whether a successor claims its uuids.
    expect(indexSource).toContain(
      "if (isClaudeCommand(command) && t.claudeSessionId) {\n    void rebindRotatedClaudeSession(t.id)"
    )
  })

  it('keeps the staleness watcher as the other trigger', () => {
    expect(indexSource).toContain('onStale: (terminalId) => void rebindRotatedClaudeSession(terminalId)')
  })

  it('still commits through the verdict, so the spawn trigger inherits the refusals', () => {
    // Same discipline either way: binding-moved, claimed hop and empty chain
    // all refuse, and the commit re-reads the store after the last await.
    expect(indexSource).toContain('const verdict = rotationCommitVerdict({')
  })
})
