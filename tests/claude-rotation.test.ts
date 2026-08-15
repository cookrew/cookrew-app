// Mid-flight Claude session rotation: following a conversation that moved to
// a new session file with no respawn, no adopt event and no exit.
//
// The fixtures below are the SHAPE probed on the confirmed rotation
// (claude 2.1.222): a `compact_boundary` system record rooting the new file,
// then a continuation summary whose `sessionId` is the new session and whose
// `session_id` is the old one. Everything the detector believes comes from
// that pair; everything else it refuses.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ROTATION_CANDIDATE_CAP,
  ROTATION_MTIME_SLACK_MS,
  readHeadLines,
  resolveRotationChain,
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

function fakeFs(files: readonly FakeFile[]): RotationFs {
  const heads = new Map(files.map((f) => [f.sessionId, f.head]))
  return {
    listSessions: (dir): SessionFileEntry[] =>
      files.map((f, i) => ({
        file: path.join(dir, `${f.sessionId}.jsonl`),
        sessionId: f.sessionId,
        mtimeMs: f.mtimeMs ?? 1000 + i,
        size: 100
      })),
    readHead: (file) => heads.get(path.basename(file, '.jsonl')) ?? []
  }
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
  it('follows the bound session to its successor', () => {
    const chain = resolveRotationChain({
      cwd: CWD,
      sessionId: OLD,
      fs: fakeFs([
        { sessionId: OLD, head: plainHead(OLD) },
        { sessionId: NEW, head: rotationHead(NEW, OLD) }
      ])
    })
    expect(chain).toEqual([NEW])
  })

  it('follows several rotations the app was blind across, oldest hop first', () => {
    const chain = resolveRotationChain({
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

  it('stays put when the file is merely quiet and nothing claims it', () => {
    // The ordinary case by far: a long tool call, not a rotation.
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: plainHead(NEW) }
        ])
      })
    ).toBeNull()
  })

  it('stays put when the bound session has no file in the project dir', () => {
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([{ sessionId: NEW, head: rotationHead(NEW, OLD) }])
      })
    ).toBeNull()
  })

  it('ignores a claimant far older than the file that went quiet', () => {
    // A successor is being written while its predecessor is frozen, so it is
    // never meaningfully older. A stale copy claiming the same parent is not
    // the live conversation.
    expect(
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
    ).toBeNull()
  })
})

describe('resolveRotationChain — refusal on ambiguity', () => {
  it('refuses when TWO files claim the same predecessor', () => {
    // A native fork copy alongside the real successor, or a session resumed
    // twice and compacted twice. Either way nothing on disk says which one
    // the pane is running: a wrong file is worse than a stale one.
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD) },
          { sessionId: THIRD, head: rotationHead(THIRD, OLD) }
        ])
      })
    ).toBeNull()
  })

  it('refuses the WHOLE chain when a later hop is ambiguous', () => {
    // Stopping at the last unambiguous hop would bind the node to a file that
    // is itself dead — a quieter version of the same bug.
    expect(
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
    ).toBeNull()
  })

  it('refuses a head whose own session id disagrees with its filename', () => {
    // A copied/renamed file. Its name is its identity; a head that contradicts
    // it has been rewritten and is not evidence of anything.
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(THIRD, OLD) }
        ])
      })
    ).toBeNull()
  })

  it('refuses a claimant stamped with a different working directory', () => {
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD, '/w/somewhere-else') }
        ])
      })
    ).toBeNull()
  })

  it('refuses a session id that is not UUID-shaped before touching the disk', () => {
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: '../../../etc/passwd',
        fs: {
          listSessions: () => {
            throw new Error('must not scan for an unusable id')
          },
          readHead: () => []
        }
      })
    ).toBeNull()
  })
})

describe('resolveRotationChain — 1:1 ownership', () => {
  it('never adopts a session another node is bound to', () => {
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        claimed: new Set([NEW]),
        fs: fakeFs([
          { sessionId: OLD, head: plainHead(OLD) },
          { sessionId: NEW, head: rotationHead(NEW, OLD) }
        ])
      })
    ).toBeNull()
  })

  it('never adopts a session that is an earlier segment of another node', () => {
    // Another node's lineage is still its history; taking one cross-wires two
    // rails, which is the failure the codex/pi binds guard the same way.
    expect(
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
    ).toBeNull()
  })

  it('adopts an unowned successor while other nodes hold their own sessions', () => {
    const chain = resolveRotationChain({
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
  it('finds the successor by reading only the head of a large session file', () => {
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

    expect(resolveRotationChain({ cwd: CWD, sessionId: OLD, projectsDir })).toEqual([NEW])
  })

  it('reads nothing and reports nothing when the project dir does not exist', () => {
    expect(
      resolveRotationChain({
        cwd: CWD,
        sessionId: OLD,
        projectsDir: path.join(tmpdir(), 'cookrew-rotation-absent')
      })
    ).toBeNull()
  })

  it('opens at most ROTATION_CANDIDATE_CAP files per probe', () => {
    const files: FakeFile[] = Array.from({ length: 40 }, (_, i) => ({
      sessionId: `0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`,
      head: plainHead('x'),
      mtimeMs: 10_000 - i
    }))
    const opened: string[] = []
    const fs = fakeFs([{ sessionId: OLD, head: plainHead(OLD), mtimeMs: 10_000 }, ...files])
    resolveRotationChain({
      cwd: CWD,
      sessionId: OLD,
      fs: { ...fs, readHead: (file) => (opened.push(file), fs.readHead(file)) }
    })
    expect(opened).toHaveLength(ROTATION_CANDIDATE_CAP)
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

  function realEdges(): RealEdge[] {
    return projectDirs().flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => {
          const file = path.join(dir, name)
          const edge = rotationEdgeOf(readHeadLines(file))
          return edge === null
            ? []
            : [{ dir, file, sessionId: edge.sessionId, predecessorId: edge.predecessorId }]
        })
    )
  }

  it('never claims a file continues itself, or continues a session it is not', () => {
    const edges = realEdges()
    if (edges.length === 0) return // no rotation on this machine yet
    for (const edge of edges) {
      // The file's name is its identity; a head that disagrees is a copy.
      expect(path.basename(edge.file, '.jsonl')).toBe(edge.sessionId)
      expect(edge.predecessorId).not.toBe(edge.sessionId)
    }
  })

  it('follows every recorded rotation to that exact successor, or refuses', () => {
    const edges = realEdges()
    if (edges.length === 0) return
    for (const edge of edges) {
      // The scan works from a terminal's cwd; the project dir is derived from
      // it, so ask the question the way the app asks it.
      const cwd = cwdOfSession(edge.file)
      if (cwd === null) continue
      const chain = resolveRotationChain({ cwd, sessionId: edge.predecessorId })
      // Refusal is always allowed (ambiguity, liveness, ownership). Landing
      // somewhere OTHER than the successor the file itself names is not.
      if (chain !== null) expect(chain[0]).toBe(edge.sessionId)
    }
  })
})

/** The cwd a session file stamps on its records, read from its head. */
function cwdOfSession(file: string): string | null {
  for (const line of readHeadLines(file)) {
    try {
      const record = JSON.parse(line) as { cwd?: string }
      if (typeof record.cwd === 'string') return record.cwd
    } catch {
      continue
    }
  }
  return null
}

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
