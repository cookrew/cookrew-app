import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStreamService, type StreamService } from '../src/main/stream-service'
import { blocksOfRows, fileOfRow, filesOfRows, windowRows } from '../src/main/stream-window'
import { TraceReader, type TraceDocument } from '../src/main/trace'
import { WorkspaceStore } from '../src/main/store'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'
import type { ProjectedCheckpoint } from '../src/shared/stream-projection'

/**
 * A BLOCK WINDOW READS THE FILES IT SPANS, AND NOTHING ELSE.
 *
 * The transcript drawer fills every screen from `/stream?after=`, and until
 * 2026-10-04 that route walked the whole chain for every page — every
 * transcript in the lineage opened and parsed to hand back twenty blocks that
 * live in one of them. On the owner's busiest card that was eight files and
 * 220 MB for a 177 KB answer, 30.5 s for the first window after a restart.
 *
 * The materialised index already names the file each row is read from. The
 * structural half of this suite is the one a fast machine cannot fake: a
 * window over a three-file chain reads ONE document when its rows live in one
 * file, and the files in front of it are never opened.
 */

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const prompt = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(ms), message: { role: 'user', content: text } })

const reply = (text: string, ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
  })

const turns = (tag: string, count: number, from: number): string[] =>
  Array.from({ length: count }, (_, at) => {
    const n = from + at
    return [prompt(`${tag}-u${n}`, `ask ${n}`, T0 + n * 1000), reply(`reply ${n}`, T0 + n * 1000 + 400)]
  }).flat()

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 't-win',
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

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'

/** A three-file chain, 4 + 3 + 3 turns, with every document read counted per file. */
function bed() {
  const base = mkdtempSync(path.join(tmpdir(), 'win-projects-'))
  const stateDir = mkdtempSync(path.join(tmpdir(), 'win-state-'))
  const marksDir = mkdtempSync(path.join(tmpdir(), 'win-marks-'))
  const cwd = '/work/repo'
  const dir = path.join(base, claudeProjectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${A}.jsonl`), `${turns('a', 4, 1).join('\n')}\n`)
  writeFileSync(path.join(dir, `${B}.jsonl`), `${turns('b', 3, 10).join('\n')}\n`)
  writeFileSync(path.join(dir, `${C}.jsonl`), `${turns('c', 3, 20).join('\n')}\n`)

  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'win-ws-')))
  const node = store.addNode(terminal({ cwd, claudeSessionId: C })) as TerminalNodeData
  const traces = new TraceReader(store, { projectsDir: base })
  const reads = new Map<string, number>()
  let lineage: string[] = [A, B, C]
  const service = createStreamService({
    nodeOf: () => node,
    documentOf: (target, kind) => {
      reads.set(path.basename(target), (reads.get(path.basename(target)) ?? 0) + 1)
      return traces.documentOf(target, kind)
    },
    chainOptions: { projectsDir: base, lineageIds: () => lineage },
    markOptions: { dir: marksDir },
    stateOptions: { dir: stateDir },
    chainCoalesceMs: 0
  })
  const readsSince = (): Record<string, number> => {
    const out = Object.fromEntries(reads)
    reads.clear()
    return out
  }
  return {
    service,
    readsSince,
    files: { dir, A: `${A}.jsonl`, B: `${B}.jsonl`, C: `${C}.jsonl` },
    ageOut: (ids: string[]) => void (lineage = ids)
  }
}

const indexOf = (service: StreamService, id: string) => {
  const read = service.materialised
  if (read === undefined) throw new Error('this service was built without a materialised index')
  return read(id)
}

describe('windowRows — the paging rule, over index rows', () => {
  const row = (ordinal: number, patch: Partial<ProjectedCheckpoint> = {}): ProjectedCheckpoint => ({
    identity: `id-${ordinal}`,
    ordinal,
    startedAt: T0 + ordinal,
    endedAt: T0 + ordinal + 1,
    promptHead: `ask ${ordinal}`,
    compacted: false,
    file: '/t/one.jsonl',
    firstAt: T0,
    latestAt: T0,
    occurrences: [{ file: '/t/one.jsonl', byteOffset: 10 }],
    ...patch
  })
  const rows = [row(1), row(2), row(3, { rolledBack: true }), row(4), row(5)]

  it('cuts the first page from the oldest row', () => {
    expect(windowRows(rows, { limit: 2 }, 20).rows.map((r) => r.ordinal)).toEqual([1, 2])
  })

  it('pages forward from `after` and backward from `before`, short at the ends', () => {
    expect(windowRows(rows, { after: 'id-1', limit: 2 }, 20).rows.map((r) => r.ordinal)).toEqual([2, 4])
    expect(windowRows(rows, { before: 'id-2', limit: 5 }, 20).rows.map((r) => r.ordinal)).toEqual([1])
  })

  it('says an unknown cursor out loud rather than falling back to the start', () => {
    expect(windowRows(rows, { after: 'nope' }, 20)).toEqual({ rows: [], unknownAfter: true })
    expect(windowRows(rows, { before: 'nope' }, 20)).toEqual({ rows: [], unknownBefore: true })
  })

  it('never counts a rolled-back row toward a page — the walk never saw it', () => {
    // Three blocks asked for, three delivered: ordinal 3 has no bytes and is
    // not a hole in the page any more than it was when the walk was sliced.
    expect(windowRows(rows, { after: 'id-1', limit: 3 }, 20).rows.map((r) => r.ordinal)).toEqual([2, 4, 5])
    // Nor can it be a cursor: nothing addresses a block that is not there.
    expect(windowRows(rows, { after: 'id-3' }, 20).unknownAfter).toBe(true)
  })

  it('takes the reader’s default when no limit is asked for', () => {
    expect(windowRows(rows, {}, 3).rows).toHaveLength(3)
  })

  it('never counts a row whose transcript is gone, either — it has no bytes to serve', () => {
    const mixed = [
      row(1, { occurrences: [{ file: '/t/gone.jsonl', byteOffset: 5 }] }),
      row(2, { occurrences: [{ file: '/t/gone.jsonl', byteOffset: 9 }] }),
      row(3),
      row(4)
    ]
    const gone = new Set(['/t/gone.jsonl'])
    // The first page is the first rows that are ON DISK — what the walk, which
    // only ever saw files that exist, handed back for a cursorless request.
    expect(windowRows(mixed, { limit: 2 }, 20, gone).rows.map((r) => r.ordinal)).toEqual([3, 4])
    // And a cursor into the gone file is as unknown as it was to the walk.
    expect(windowRows(mixed, { after: 'id-1' }, 20, gone).unknownAfter).toBe(true)
  })
})

describe('blocksOfRows — assembling a window from the files it names', () => {
  const doc = (ids: string[]): TraceDocument => ({
    blocks: ids.map((id, at) => ({
      id,
      index: at,
      prompt: `p ${id}`,
      reply: `r ${id}`,
      activity: [],
      startedAt: T0,
      endedAt: T0 + 1
    })),
    markers: [],
    bytesRead: 100
  })
  const row = (ordinal: number, identity: string, files: string[]): ProjectedCheckpoint => ({
    identity,
    ordinal,
    startedAt: T0,
    endedAt: T0 + 1,
    promptHead: 'p',
    compacted: ordinal === 3,
    ...(ordinal === 3 ? { previousSessionId: 'old', compaction: { preTokens: 1000, postTokens: 100 } } : {}),
    file: files[0],
    firstAt: T0,
    latestAt: T0,
    occurrences: files.map((file) => ({ file, byteOffset: 1 }))
  })

  it('reads a row from its NEWEST occurrence — where the exchange is now', () => {
    const replayed = row(2, 'x', ['/t/old.jsonl', '/t/new.jsonl'])
    expect(fileOfRow(replayed)).toBe('/t/new.jsonl')
    expect(filesOfRows([replayed, row(1, 'y', ['/t/old.jsonl'])])).toEqual(['/t/new.jsonl', '/t/old.jsonl'])
  })

  it('stamps every field the walk stamped, from the row that holds it', () => {
    const documents = new Map([['/t/new.jsonl', doc(['x', 'y'])]])
    const [block] = blocksOfRows([row(3, 'y', ['/t/new.jsonl'])], documents, () => 'sess')
    expect(block).toMatchObject({
      id: 'y',
      ordinal: 3,
      compacted: true,
      previousSessionId: 'old',
      compaction: { preTokens: 1000, postTokens: 100 },
      file: '/t/new.jsonl',
      sessionId: 'sess',
      prompt: 'p y'
    })
  })

  it('omits a row whose bytes are not in its file, and never invents one', () => {
    const documents = new Map([['/t/new.jsonl', doc(['x'])]])
    const blocks = blocksOfRows(
      [row(1, 'x', ['/t/new.jsonl']), row(2, 'gone', ['/t/new.jsonl']), row(3, 'z', ['/t/missing.jsonl'])],
      documents,
      (file) => path.basename(file, '.jsonl')
    )
    expect(blocks.map((b) => b.id)).toEqual(['x'])
    expect(blocks[0].sessionId).toBe('new')
  })

  it('hands back new objects, never the cached block itself', () => {
    const document = doc(['x'])
    const documents = new Map([['/t/new.jsonl', document]])
    const [block] = blocksOfRows([row(1, 'x', ['/t/new.jsonl'])], documents, () => 's')
    expect(block).not.toBe(document.blocks[0])
    expect(document.blocks[0]).not.toHaveProperty('ordinal')
  })
})

describe('service.blocks — THE STRUCTURAL GATE: only the files a window spans are read', () => {
  it('reads one document for a window that lives in one file, out of a three-file chain', async () => {
    const { service, readsSince, files } = bed()
    // Materialise once, as an open does; the window below is the SECOND read
    // of the card, which is what every scroll fill and every jump is.
    await indexOf(service, 't-win')
    readsSince()
    const page = await service.blocks('t-win', { after: 'b-u11', limit: 3 })
    expect(page.blocks.map((b) => b.ordinal)).toEqual([7, 8, 9])
    expect(page.blocks.map((b) => b.sessionId)).toEqual([B, C, C])
    // Two files hold those three blocks. The oldest transcript — the one a
    // whole-chain walk would have parsed first — is never opened. (The
    // materialise this call also makes resumes from the cursor and reads the
    // tail file alone, so C's count is the window's read plus that one.)
    const reads = readsSince()
    expect(reads[files.A]).toBeUndefined()
    expect(reads[files.B]).toBe(1)
    expect(reads[files.C]).toBeGreaterThanOrEqual(1)
  })

  it('answers the same page, block for block, as the chain walk did', async () => {
    const { service } = bed()
    await indexOf(service, 't-win')
    const first = await service.blocks('t-win', { limit: 4 })
    expect(first.blocks.map((b) => [b.ordinal, b.id, b.prompt])).toEqual([
      [1, 'a-u1', 'ask 1'],
      [2, 'a-u2', 'ask 2'],
      [3, 'a-u3', 'ask 3'],
      [4, 'a-u4', 'ask 4']
    ])
    expect(first.total).toBe(10)
    const next = await service.blocks('t-win', { after: 'a-u4', limit: 4 })
    expect(next.blocks.map((b) => b.ordinal)).toEqual([5, 6, 7, 8])
    // The first block of a rotated-into file wears the rotation, as the walk
    // placed it: compacted, pointing back at the session it rotated out of.
    expect(next.blocks[0]).toMatchObject({ compacted: true, previousSessionId: A, sessionId: B })
    const back = await service.blocks('t-win', { before: 'c-u21', limit: 3 })
    expect(back.blocks.map((b) => b.ordinal)).toEqual([6, 7, 8])
    expect(await service.blocks('t-win', { after: 'nowhere' })).toMatchObject({ unknownAfter: true, total: 10 })
  })

  it('serves a block out of a transcript the lineage no longer lists — the file is an address', async () => {
    const { service, ageOut } = bed()
    await indexOf(service, 't-win')
    // The oldest rotation ages out of the lineage. Its rows stay in the index
    // at their ordinals, and its file is still on disk: the walk could not
    // reach them (442 unfillable rail rows on the owner's card); this can.
    ageOut([B, C])
    const page = await service.blocks('t-win', { limit: 5 })
    expect(page.blocks.map((b) => b.ordinal)).toEqual([1, 2, 3, 4, 5])
    expect(page.blocks[0].sessionId).toBe(A)
    expect(page.total).toBe(10)
  })

  it('skips the rows of a transcript deleted since the index was built — the first page is still twenty blocks', async () => {
    const { service, readsSince, files, ageOut } = bed()
    await indexOf(service, 't-win')
    // The oldest transcript is deleted but still in the lineage: the index
    // keeps its four rows (a deletion is not a renumbering), the chain reports
    // it missing, and a cursorless page starts at the first row with bytes —
    // exactly where the walk, which never saw the file, started.
    rmSync(path.join(files.dir, files.A))
    readsSince()
    const page = await service.blocks('t-win', { limit: 3 })
    expect(page.blocks.map((b) => b.ordinal)).toEqual([5, 6, 7])
    expect(page.total).toBe(10)
    expect(page.missing.map((m) => path.basename(m.file))).toEqual([files.A])
    expect(readsSince()[files.A]).toBeUndefined()
    // A cursor into the deleted file is unknown, as it was to the walk.
    expect((await service.blocks('t-win', { after: 'a-u2' })).unknownAfter).toBe(true)
    // And once the lineage forgets the file too — the chain no longer reports
    // it missing, because it no longer reports it at all — the rows are still
    // skipped: the file is neither listed nor on disk. This is the shape of the
    // owner's card, where `missing` was empty and 693 rows pointed at nothing.
    ageOut([B, C])
    const forgotten = await service.blocks('t-win', { limit: 3 })
    expect(forgotten.blocks.map((b) => b.ordinal)).toEqual([5, 6, 7])
    expect(forgotten.missing).toEqual([])
  })

  it('answers a card on its very first read, before any snapshot exists', async () => {
    const { service, readsSince, files } = bed()
    // No snapshot on disk: this call materialises first (a cold pass over all
    // three files, the honest floor) and then answers from the index it just
    // built. The point is that a brand-new card answers, in order.
    const page = await service.blocks('t-win', { limit: 2 })
    expect(page.blocks.map((b) => b.ordinal)).toEqual([1, 2])
    expect(readsSince()[files.A]).toBeGreaterThanOrEqual(1)
  })
})
