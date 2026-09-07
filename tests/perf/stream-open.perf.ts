// WHAT /stream/open COSTS ON THE OWNER'S BUSIEST CARD (D6, T5 QA 2026-09-07).
//
// THE DEFECT. /stream/open on a 9-file, 1,048-block chain exceeded a 30 s
// client timeout once, and the companion tab froze twice with that card's
// overlay open. The existing streamIndex1000 gate measures the PROJECTION with
// its lines already in hand — it never reads a file — so the whole cost of the
// answer was unmeasured: every open re-walked the chain, and the walk loads and
// parses every transcript in it before the projection sees a single line.
//
// WHAT THIS GATES, that streamIndex1000 does not:
//
//   COLD  — a card opening after a restart: no persisted state, no parsed
//           documents. This is the honest floor; it is bounded by the bytes on
//           disk and nothing here can make it free.
//   WARM  — the SAME card opened again with ~/.cookrew/stream/<id>.json on
//           disk. This is the one the defect is about: it used to repeat the
//           whole walk, and the structural assertion below is that it does not
//           read a single document past the tail.
//
// THE STRUCTURAL HALF IS THE REAL GATE, as with streamIndex1000: a warm open
// that reads one document instead of nine cannot be faked by a fast machine.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createStreamService } from '../../src/main/stream-service'
import { TraceReader } from '../../src/main/trace'
import { WorkspaceStore } from '../../src/main/store'
import { claudeProjectSlug } from '../../src/shared/claude-fork'
import type { TerminalNodeData } from '../../src/shared/model'
import { LATENCY } from './budgets'
import { expectEvery, expectTail, measure, removeRoot, tempRoot } from './perf-harness'

/** The owner's busiest card: nine transcripts, 1,048 exchanges between them. */
const FILES = 9
const BLOCKS = 1048
/** Tool records per exchange — what makes a real transcript large rather than
 *  long. Nine files of ~120 exchanges at this weight is ~18 MB on disk. */
const TOOL_RECORDS = 6
const TOOL_RESULT_CHARS = 1800

const T0 = Date.parse('2026-09-01T09:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const sessionId = (at: number): string =>
  `${String(at + 1).padStart(8, '0')}-3333-4444-5555-666666666666`

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

/** One exchange: a prompt, its tool traffic, and its closing reply. */
function exchange(ordinal: number): string[] {
  const at = T0 + ordinal * 60_000
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: `u${ordinal}`,
      timestamp: iso(at),
      message: { role: 'user', content: `checkpoint ${ordinal}: run the thing` }
    })
  ]
  for (let n = 0; n < TOOL_RECORDS; n += 1) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: iso(at + n * 2),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${ordinal}-${n}`, name: 'Read', input: { file_path: '/repo/src/a.ts' } }],
          stop_reason: 'tool_use'
        }
      }),
      JSON.stringify({
        type: 'user',
        timestamp: iso(at + n * 2 + 1),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: `t${ordinal}-${n}`, content: 'x'.repeat(TOOL_RESULT_CHARS) }
          ]
        }
      })
    )
  }
  lines.push(
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(at + 30),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `done with ${ordinal}` }],
        stop_reason: 'end_turn'
      }
    })
  )
  return lines
}

/** The chain on disk, plus the node and the dirs a service needs. */
function chainOnDisk() {
  const root = tempRoot('stream-open-perf-')
  roots.push(root)
  const projects = path.join(root, 'projects')
  const cwd = '/work/repo'
  const dir = path.join(projects, claudeProjectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  const perFile = Math.ceil(BLOCKS / FILES)
  const ids: string[] = []
  let ordinal = 0
  for (let at = 0; at < FILES; at += 1) {
    const id = sessionId(at)
    ids.push(id)
    const lines: string[] = []
    if (at > 0) {
      lines.push(
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          compactMetadata: { trigger: 'auto', preTokens: 120_000, postTokens: 9_000 }
        })
      )
    }
    for (let n = 0; n < perFile && ordinal < BLOCKS; n += 1) {
      ordinal += 1
      lines.push(...exchange(ordinal))
    }
    writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`)
  }
  return {
    root,
    projects,
    cwd,
    ids,
    marksDir: path.join(root, 'marks'),
    stateDir: path.join(root, 'state')
  }
}

function terminal(cwd: string, claudeSessionId: string): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 'busiest',
    name: 'Agent',
    preset: 'Claude Code',
    command: 'claude',
    cwd,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    claudeSessionId
  }
}

/**
 * A service over the fixture, with every document read COUNTED.
 *
 * The count is the structural gate: a warm open that walks the chain reads
 * nine documents, and one that replays from the cursor reads the tail alone.
 */
function serviceOver(bed: ReturnType<typeof chainOnDisk>) {
  const store = new WorkspaceStore(path.join(bed.root, `ws-${Math.random().toString(36).slice(2)}`))
  const node = store.addNode(
    terminal(bed.cwd, bed.ids[bed.ids.length - 1])
  ) as TerminalNodeData
  const traces = new TraceReader(store, { projectsDir: bed.projects })
  let reads = 0
  const service = createStreamService({
    nodeOf: () => node,
    documentOf: (file, kind) => {
      reads += 1
      return traces.documentOf(file, kind)
    },
    chainOptions: { projectsDir: bed.projects, lineageIds: () => [...bed.ids] },
    markOptions: { dir: bed.marksDir },
    stateOptions: { dir: bed.stateDir }
  })
  return { service, reads: () => reads }
}

/** The work /stream/open performs: the rail's rows and the settled tail. */
async function openOnce(service: ReturnType<typeof serviceOver>['service']) {
  const [checkpoints, tail] = await Promise.all([
    service.checkpoints('busiest'),
    service.tailState('busiest')
  ])
  return { rows: checkpoints.checkpoints.length, total: tail.total, final: tail.final }
}

describe('/stream/open — a 9-file, 1,048-block chain', () => {
  const bed = chainOnDisk()

  it('COLD: no persisted state, no parsed documents — the honest floor', async () => {
    const measured = await measure(
      'stream open cold (9 files, 1048 blocks)',
      async () => {
        // A FRESH service every sample: new trace cache, new state dir, so
        // this is what a card opening after a restart actually pays.
        const fresh = chainOnDisk()
        const { service, reads } = serviceOver(fresh)
        const started = performance.now()
        const answer = await openOnce(service)
        const elapsed = performance.now() - started
        return {
          elapsed,
          structural: { rows: answer.rows, total: answer.total, final: answer.final, reads: reads() }
        }
      },
      // Cold samples build a whole chain on disk each time; five is enough to
      // see the tail and keeps the suite inside its own timeout.
      5
    )
    expectTail(measured, LATENCY.streamOpenCold1048)
    expectEvery(measured, 'rows', BLOCKS)
    expectEvery(measured, 'total', BLOCKS)
    // The tail's own end_turn is found from the block's span (D4).
    expectEvery(measured, 'final', true)
  })

  it('WARM: the persisted snapshot answers, and only the tail is re-read', async () => {
    const { service } = serviceOver(bed)
    // One cold pass writes ~/.cookrew/stream/<id>.json and fills the trace
    // cache; every measured pass below is the SECOND open of the same card.
    await openOnce(service)
    const measured = await measure('stream open warm (9 files, 1048 blocks)', async () => {
      const { service: reopened, reads } = serviceOver(bed)
      const started = performance.now()
      const answer = await openOnce(reopened)
      const elapsed = performance.now() - started
      return {
        elapsed,
        structural: { rows: answer.rows, total: answer.total, reads: reads() }
      }
    })
    expectTail(measured, LATENCY.streamOpenWarm1048)
    expectEvery(measured, 'rows', BLOCKS)
    expectEvery(measured, 'total', BLOCKS)
    // THE STRUCTURAL GATE, and the load-bearing half. Nine transcripts in the
    // chain; TWO document reads for the whole answer — one for the index walk
    // and one for the tail's — and each of those touches the cursor's file
    // alone. It was 27 (nine files, three walks) before D6. No machine can be
    // fast enough to fake this.
    expectEvery(measured, 'reads', 2)
  })

  it('a warm open agrees with a cold one, row for row', async () => {
    const fresh = chainOnDisk()
    const cold = serviceOver(fresh)
    const first = await cold.service.checkpoints('busiest')
    const warm = serviceOver(fresh)
    const second = await warm.service.checkpoints('busiest')
    expect(second.checkpoints.map((row) => row.ordinal)).toEqual(
      first.checkpoints.map((row) => row.ordinal)
    )
    expect(second.checkpoints.map((row) => row.identity)).toEqual(
      first.checkpoints.map((row) => row.identity)
    )
    expect(warm.reads()).toBe(1)
  })
})
