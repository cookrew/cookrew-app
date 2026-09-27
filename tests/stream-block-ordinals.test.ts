import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStreamService, type StreamService } from '../src/main/stream-service'
import { TraceReader } from '../src/main/trace'
import { WorkspaceStore } from '../src/main/store'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'

/**
 * A BLOCK WINDOW MUST ARRIVE IN THE NUMBER THE RAIL IS LAID OUT IN.
 *
 * Two records number the same turn. The MATERIALISED INDEX numbers it over the
 * whole chain and never renumbers — an ordinal it has issued is that turn's
 * ordinal for good. The WALK numbers whatever blocks are on disk right now,
 * contiguously from 1. They agree only while the chain still holds everything
 * the index has ever seen, and they stop agreeing the moment it does not.
 *
 * `tailState` was taught this in T5 QA (2026-09-07) — "the ordinal and total
 * must come from ONE record" — after a rewound card put its newest checkpoint
 * at 78% of the rail. The block WINDOW was never taught it, and that is a
 * worse failure than a misplaced marker, because the drawer addresses blocks
 * BY ordinal:
 *
 *   · every position the index numbers above the walk's length can never be
 *     filled — the window has no block with that number — so the transcript
 *     shows a run of empty placeholders, and
 *   · every block that does arrive lands on the row of a DIFFERENT turn, so
 *     the checkpoints that are not empty are showing somebody else's words.
 *
 * Measured on the owner's own card before the fix: the index held 1122 turns
 * and the walk 680, a constant gap of 442. Every walked block was placeable by
 * the index, which is why renumbering from it is exact and not a guess.
 */

const T0 = Date.parse('2026-09-20T09:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const prompt = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(ms), message: { role: 'user', content: text } })

const reply = (text: string, ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
  })

/** One session file's worth of turns, each a prompt and a settled reply. */
const turns = (tag: string, count: number, from: number): string[] =>
  Array.from({ length: count }, (_, at) => {
    const n = from + at
    return [prompt(`${tag}-u${n}`, `ask ${n}`, T0 + n * 1000), reply(`reply ${n}`, T0 + n * 1000 + 400)]
  }).flat()

/** `materialised` is OPTIONAL on the interface so a composed test double can
 *  be a StreamService without one. The real service always has it, and a test
 *  about the index is worthless if it silently skips reading it. */
const indexOf = (service: StreamService, id: string) => {
  const read = service.materialised
  if (read === undefined) throw new Error('this service was built without a materialised index')
  return read(id)
}

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 't-ord',
    name: 'Agent',
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

const OLD = '11111111-1111-4111-8111-111111111111'
const NOW = '22222222-2222-4222-8222-222222222222'

/**
 * A card whose chain once held two transcripts and now resolves only the
 * newer one — a compaction rotation that has aged out of the lineage, which is
 * how the two records come apart in the field.
 */
function bed(older: number, newer: number) {
  const base = mkdtempSync(path.join(tmpdir(), 'ord-projects-'))
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ord-state-'))
  const marksDir = mkdtempSync(path.join(tmpdir(), 'ord-marks-'))
  const cwd = '/work/repo'
  const dir = path.join(base, claudeProjectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${OLD}.jsonl`), `${turns('a', older, 1).join('\n')}\n`)
  writeFileSync(path.join(dir, `${NOW}.jsonl`), `${turns('b', newer, 100).join('\n')}\n`)

  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'ord-ws-')))
  const node = store.addNode(terminal({ cwd, claudeSessionId: NOW })) as TerminalNodeData
  const traces = new TraceReader(store, { projectsDir: base })
  // The lineage the chain resolves, swapped mid-test: both files while the
  // index is built, the newer one alone afterwards.
  let lineage: string[] = [OLD, NOW]
  const service = createStreamService({
    nodeOf: () => node,
    documentOf: (target, kind) => traces.documentOf(target, kind),
    chainOptions: { projectsDir: base, lineageIds: () => lineage },
    markOptions: { dir: marksDir },
    stateOptions: { dir: stateDir },
    chainCoalesceMs: 0
  })
  return { service, ageOutTheOlderFile: () => void (lineage = [NOW]) }
}

describe('a block window when the walk is shorter than the index', () => {
  it('numbers every block the way the index does, not the way the walk does', async () => {
    const { service, ageOutTheOlderFile } = bed(3, 2)
    // Both files are in the chain, so the two records agree: five turns, and
    // the newer file's two are 4 and 5.
    const index = await indexOf(service, 't-ord')
    expect(index.entries.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5])

    ageOutTheOlderFile()
    const page = await service.blocks('t-ord', { limit: 10 })
    // The walk now finds two blocks and would call them 1 and 2. The index has
    // already issued 4 and 5 for those identities, and an issued ordinal is
    // the turn's ordinal — the rail, the placeholders and every jump are laid
    // out in it.
    expect(page.blocks.map((b) => b.ordinal)).toEqual([4, 5])
  })

  it('reports the index’s total, so the drawer does not prune what it just fetched', async () => {
    // `total` is the drawer's ceiling: it drops every loaded block numbered
    // above it (pruneToTotal). Publishing the walk's length here threw away
    // the very blocks this window had just delivered.
    const { service, ageOutTheOlderFile } = bed(3, 2)
    await indexOf(service, 't-ord')
    ageOutTheOlderFile()
    const page = await service.blocks('t-ord', { limit: 10 })
    expect(page.total).toBe(5)
    for (const block of page.blocks) expect(block.ordinal).toBeLessThanOrEqual(page.total)
  })

  it('keeps identity paging working in the index’s numbers', async () => {
    const { service, ageOutTheOlderFile } = bed(3, 2)
    await indexOf(service, 't-ord')
    ageOutTheOlderFile()
    const all = await service.blocks('t-ord', { limit: 10 })
    const first = all.blocks[0]
    const after = await service.blocks('t-ord', { after: first.id, limit: 10 })
    // Cursors are identities and are untouched by the renumbering; what must
    // follow is the NEXT ordinal in the index's space.
    expect(after.blocks.map((b) => b.ordinal)).toEqual([5])
    expect(after.total).toBe(5)
  })
})

describe('a block window when the two records agree', () => {
  it('is left exactly as it was — this changes nothing about the ordinary card', async () => {
    const { service } = bed(3, 2)
    await indexOf(service, 't-ord')
    const page = await service.blocks('t-ord', { limit: 10 })
    expect(page.blocks.map((b) => b.ordinal)).toEqual([1, 2, 3, 4, 5])
    expect(page.total).toBe(5)
  })
})
