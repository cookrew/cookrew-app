// Walking a checkpoint history back across compacts.
//
// The ledger is built from the current session file alone, so every compact
// restarts the numbering at 1 and the conversation before it stops being
// addressable. The join was always machine-readable — a compact_boundary whose
// summary names the predecessor — and claude-rotation.ts already parses it.
// Nothing consumed it. These hold the walk that now does.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProjectDir } from '../src/main/claude-fork'
import { ROTATION_HEAD_LINES } from '../src/main/claude-rotation'
import {
  MAX_LINEAGE_DEPTH,
  overlapPredecessor,
  refuseRenumber,
  sessionChain
} from '../src/main/lineage-ledger'

const CWD = '/w/proj'
let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lineage-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const id = (n: number): string =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`

/** The head claude writes at a compact: the boundary, then the summary that
 *  names the predecessor in `session_id` while `sessionId` is the new file. */
function writeSession(own: string, predecessor: string | null): void {
  const dir = claudeProjectDir(CWD, root)
  mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'user', sessionId: own, cwd: CWD })]
  if (predecessor !== null) {
    lines.unshift(
      JSON.stringify({
        parentUuid: null,
        logicalParentUuid: 'aaaaaaaa-0000-4000-8000-000000000000',
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 1, postTokens: 1 },
        sessionId: own,
        cwd: CWD
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued…' },
        sessionId: own,
        session_id: predecessor,
        cwd: CWD
      })
    )
  }
  writeFileSync(path.join(dir, `${own}.jsonl`), `${lines.join('\n')}\n`)
}

describe('sessionChain — walking back across compacts', () => {
  it('returns the whole chain, oldest first', async () => {
    writeSession(id(1), null)
    writeSession(id(2), id(1))
    writeSession(id(3), id(2))
    const chain = await sessionChain(CWD, id(3), { projectsDir: root })
    expect(chain.map((s) => s.sessionId)).toEqual([id(1), id(2), id(3)])
  })

  it('is just the one session when nothing was compacted', async () => {
    writeSession(id(1), null)
    const chain = await sessionChain(CWD, id(1), { projectsDir: root })
    expect(chain.map((s) => s.sessionId)).toEqual([id(1)])
  })

  it('STOPS at a predecessor whose transcript is gone, rather than inventing one', async () => {
    // A deleted or unsynced transcript truncates the history. A shorter TRUE
    // history beats a longer fabricated one, and the alternative is a chain
    // with a hole in the middle that nothing downstream could detect.
    writeSession(id(2), id(1)) // id(1) never written
    const chain = await sessionChain(CWD, id(2), { projectsDir: root })
    expect(chain.map((s) => s.sessionId)).toEqual([id(2)])
  })

  it('does not loop forever on a transcript that names itself', async () => {
    writeSession(id(1), id(1))
    const chain = await sessionChain(CWD, id(1), { projectsDir: root })
    expect(chain.map((s) => s.sessionId)).toEqual([id(1)])
  })

  it('does not loop forever on a cycle between two transcripts', async () => {
    // A copied transcript can produce this. It walks the real files once and
    // stops at the repeat rather than spinning inside the main process.
    writeSession(id(1), id(2))
    writeSession(id(2), id(1))
    const chain = await sessionChain(CWD, id(2), { projectsDir: root })
    expect(chain.length).toBeLessThanOrEqual(2)
    expect(new Set(chain.map((s) => s.sessionId)).size).toBe(chain.length)
  })

  it('caps the walk instead of reading an unbounded number of files', async () => {
    for (let n = 1; n <= MAX_LINEAGE_DEPTH + 10; n += 1) {
      writeSession(id(n), n === 1 ? null : id(n - 1))
    }
    const chain = await sessionChain(CWD, id(MAX_LINEAGE_DEPTH + 10), { projectsDir: root })
    expect(chain.length).toBe(MAX_LINEAGE_DEPTH)
  })

  it('finds an edge that sits BEYOND claude-rotation\'s 24-line head window', async () => {
    // Not hypothetical. Commander's own chain hides its boundary at lines
    // 26-27, two past ROTATION_HEAD_LINES. Walking with that window read the
    // edge as absent, stopped one file early, and silently dropped a 119 MB
    // predecessor and everything behind it — a history that is quietly partial,
    // which fails exactly like one that is quietly wrong.
    const dir = claudeProjectDir(CWD, root)
    mkdirSync(dir, { recursive: true })
    const chrome = Array.from({ length: ROTATION_HEAD_LINES + 6 }, (_, i) =>
      JSON.stringify({ type: 'system', subtype: 'ai-title', n: i, sessionId: id(2), cwd: CWD })
    )
    const lines = [
      ...chrome,
      JSON.stringify({
        parentUuid: null,
        logicalParentUuid: 'aaaaaaaa-0000-4000-8000-000000000000',
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 1, postTokens: 1 },
        sessionId: id(2),
        cwd: CWD
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'continued…' },
        sessionId: id(2),
        session_id: id(1),
        cwd: CWD
      })
    ]
    writeFileSync(path.join(dir, `${id(2)}.jsonl`), `${lines.join('\n')}\n`)
    writeSession(id(1), null)

    const chain = await sessionChain(CWD, id(2), { projectsDir: root })
    expect(chain.map((s) => s.sessionId)).toEqual([id(1), id(2)])
  })

  it('returns nothing when the session itself has no transcript', async () => {
    expect(await sessionChain(CWD, id(9), { projectsDir: root })).toEqual([])
  })
})

describe('refuseRenumber — version pins are still index-keyed', () => {
  it('permits a node that carries no pins', () => {
    expect(refuseRenumber('term-1', 0)).toBeNull()
  })

  it('REFUSES a node that carries pins, with a reason a person can act on', () => {
    // Explicit, not incidental. No node carries a pin today, which is exactly
    // why this is written now: the first one will arrive long after this
    // commit and nobody will be watching for it.
    const refusal = refuseRenumber('term-1', 3)
    expect(refusal?.reason).toBe('version-pins-are-index-keyed')
    expect(refusal?.detail).toContain('3 version pin')
    expect(refusal?.detail).toContain('Re-key pins by checkpoint uuid first')
  })
})

/**
 * /clear leaves NO compact_boundary, so the join can only be inferred from a
 * replay overlap. That is a heuristic where the compact case had a fact, and a
 * wrong join splices a stranger's checkpoints onto this agent's rail —
 * invisible from the UI, unlike a history that is merely short. So every one of
 * these asserts a REFUSAL except the single unambiguous case.
 */
describe('inferring a /clear join — refuses rather than guesses', () => {
  /** Message uuids must be real uuid shapes — headMessageUuids filters on it. */
  const uuids = (n: number, from = 0): string[] =>
    Array.from(
      { length: n },
      (_, i) => `${String(from + i).padStart(8, 'c')}-2222-4222-8222-222222222222`
    )

  /** A file whose head carries these message uuids. */
  function writeReplay(own: string, messageUuids: readonly string[]): void {
    const dir = claudeProjectDir(CWD, root)
    mkdirSync(dir, { recursive: true })
    const lines = messageUuids.map((u) =>
      JSON.stringify({ type: 'user', uuid: u, sessionId: own, cwd: CWD, message: { role: 'user' } })
    )
    writeFileSync(path.join(dir, `${own}.jsonl`), `${lines.join('\n')}\n`)
  }

  const fs = {
    listSessionFiles: () => [],
    headLines: async (file: string) =>
      (await import('node:fs')).readFileSync(file, 'utf8').split('\n').filter(Boolean)
  }

  const step = (n: number) => ({
    sessionId: id(n),
    file: path.join(claudeProjectDir(CWD, root), `${id(n)}.jsonl`)
  })

  it('joins when exactly one file is demonstrably replayed', async () => {
    writeReplay(id(1), uuids(12))
    writeReplay(id(2), uuids(12)) // replays all of id(1)
    const out = await overlapPredecessor(step(2).file, [step(1)], fs)
    expect('step' in out && out.step.sessionId).toBe(id(1))
  })

  it('REFUSES when two files both clear the bar', async () => {
    // The ambiguity that matters: a fork leaves two plausible predecessors and
    // the higher ratio is not evidence, it is a preference.
    writeReplay(id(1), uuids(12))
    writeReplay(id(2), uuids(12))
    writeReplay(id(3), uuids(12))
    const out = await overlapPredecessor(step(3).file, [step(1), step(2)], fs)
    expect('refused' in out && out.refused.reason).toBe('ambiguous')
    expect('refused' in out && out.refused.detail).toContain('would be a guess')
  })

  it('REFUSES a weak overlap rather than accepting a partial match', async () => {
    writeReplay(id(1), uuids(12))
    writeReplay(id(2), [...uuids(3), ...uuids(9, 100)]) // only 3 of 12 shared
    const out = await overlapPredecessor(step(2).file, [step(1)], fs)
    expect('refused' in out && out.refused.reason).toBe('no-candidate')
  })

  it('REFUSES when there is too little evidence to judge at all', async () => {
    writeReplay(id(1), uuids(12))
    writeReplay(id(2), uuids(3)) // below ROTATION_RESUME_MIN_UUIDS
    const out = await overlapPredecessor(step(2).file, [step(1)], fs)
    expect('refused' in out && out.refused.reason).toBe('weak-overlap')
  })

  it('is OFF unless asked for — a compact walk never infers', async () => {
    // Inference is opt-in. The compact path is a fact and must not silently
    // acquire a heuristic behind it.
    writeReplay(id(1), uuids(12))
    writeReplay(id(2), uuids(12))
    const chain = await sessionChain(CWD, id(2), { projectsDir: root })
    expect(chain.map((s) => s.sessionId)).toEqual([id(2)])
  })

  it('joins across a /clear when inference is asked for', async () => {
    writeReplay(id(1), uuids(12))
    writeReplay(id(2), uuids(12))
    const chain = await sessionChain(CWD, id(2), { projectsDir: root, inferClearJoins: true })
    expect(chain.map((s) => s.sessionId)).toEqual([id(1), id(2)])
  })
})
