import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexBaseChain,
  codexTraceAccumulatorFor,
  codexTurnParserFor
} from '../src/main/codex-lineage'
import { parseCodexTrace } from '../src/shared/trace-blocks'

const THREAD = '01a1cdcf-0000-7000-8000-00000000c0de'
const B_ROLLOUT = '01a1d56c-0000-7000-8000-00000000beef'
const C_ROLLOUT = '01a1d56c-0000-7000-8000-00000000cafe'
const D_ROLLOUT = '01a1d56c-0000-7000-8000-00000000fade'
const FIXTURE = path.join(__dirname, 'fixtures', 'codex-backtrack')
const A_REL = `2026/11/12/rollout-2026-11-12T11-31-48-${THREAD}.jsonl`
const B_REL = `2026/11/13/rollout-2026-11-13T23-00-37-${THREAD}_${B_ROLLOUT}.jsonl`
const TIMESTAMP = '2026-11-14T00:00:00.000Z'
const C_PROMPT = 'Continue after the second backtrack.'
const temporaryTrees = new Set<string>()

afterEach(() => {
  for (const dir of temporaryTrees) rmSync(dir, { recursive: true, force: true })
  temporaryTrees.clear()
})

function sessionsTree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-lineage-chain-'))
  temporaryTrees.add(dir)
  cpSync(FIXTURE, dir, { recursive: true })
  return { dir, a: path.join(dir, A_REL), b: path.join(dir, B_REL) }
}

const linesOf = (file: string): string[] => readFileSync(file, 'utf8').trimEnd().split('\n')

/** Measure UTF-8 bytes, including newlines, before a real Codex record. */
function cutBefore(file: string, ordinal: number): number {
  const lines = linesOf(file)
  const at = lines.findIndex((line) => JSON.parse(line).ordinal === ordinal)
  if (at < 0) throw new Error(`Fixture has no record at ordinal ${ordinal}`)
  return Buffer.byteLength(lines.slice(0, at).map((line) => `${line}\n`).join(''))
}

function continuation(base: string, ordinal: number, rollout = C_ROLLOUT): string {
  const file = path.join(path.dirname(base), `rollout-2026-11-14T00-00-00-${THREAD}_${rollout}.jsonl`)
  const header = {
    timestamp: TIMESTAMP,
    ordinal,
    type: 'session_meta',
    payload: {
      session_id: THREAD,
      cwd: '/Users/owner/workspace/cookrew-dev',
      timestamp: TIMESTAMP,
      history_mode: 'paginated',
      history_base: {
        thread_id: THREAD,
        end_ordinal_exclusive: ordinal,
        end_byte_offset: cutBefore(base, ordinal)
      }
    }
  }
  const events = [
    { type: 'user_message', message: C_PROMPT },
    { type: 'agent_message', message: 'The second backtrack is complete.', phase: 'final_answer' },
    { type: 'task_complete', last_agent_message: 'The second backtrack is complete.' }
  ].map((payload, index) => ({
    timestamp: TIMESTAMP,
    ordinal: ordinal + index + 1,
    type: 'event_msg',
    payload
  }))
  writeFileSync(file, [header, ...events].map((record) => `${JSON.stringify(record)}\n`).join(''))
  return file
}

type Row = { prompt: string; id: string | undefined }
type Surface = 'trace' | 'turn ledger'

function conversation(surface: Surface, file: string, dir: string): Row[] {
  if (surface === 'trace') {
    const accumulator = codexTraceAccumulatorFor(file, { sessionsDir: dir })
    accumulator.feed(linesOf(file))
    return accumulator.blocks().map(({ prompt, id }) => ({ prompt, id }))
  }
  const accumulator = codexTurnParserFor(file, { sessionsDir: dir }).createAccumulator()
  accumulator.feed(linesOf(file))
  return accumulator.records().map(({ prompt, uuid }) => ({ prompt, id: uuid }))
}

function prefixes(a: string, b: string) {
  // B keeps A's first two prompts. C cuts B before its next task_started,
  // keeping B's edited resend and its two follow-up prompts, but not its tail.
  const aRows = parseCodexTrace(linesOf(a)).slice(0, 2)
  const bRows = parseCodexTrace(linesOf(b)).slice(0, 3)
  return { aRows, bRows, prompts: [...aRows, ...bRows].map(({ prompt }) => prompt) }
}

describe.each<Surface>(['trace', 'turn ledger'])('Codex history chain through the %s', (surface) => {
  it('keeps the original base IDs when the first continuation seeds its history', () => {
    const { dir, a, b } = sessionsTree()
    const original = parseCodexTrace(linesOf(a)).slice(0, 2)
    const rows = conversation(surface, b, dir)
    expect(rows.slice(0, 2)).toEqual(original.map(({ prompt, id }) => ({ prompt, id })))
    expect(rows[2].id).toContain(B_ROLLOUT)
  })

  it('uses rollout UUIDs for distinct resends even when both files have identical timestamps', () => {
    const { dir, a, b } = sessionsTree()
    const sibling = b.replace(B_ROLLOUT, D_ROLLOUT)
    // Same records, metadata, ordinal positions and clocks; only the filename's
    // rollout UUID differs. Neither resend may inherit A's interrupted turn ID.
    writeFileSync(sibling, readFileSync(b))
    const left = conversation(surface, b, dir)
    const right = conversation(surface, sibling, dir)
    const abandoned = parseCodexTrace(linesOf(a))[2]
    expect(left.map(({ prompt }) => prompt)).toEqual(right.map(({ prompt }) => prompt))
    expect.soft(left[2].id).toContain(B_ROLLOUT)
    expect.soft(right[2].id).toContain(D_ROLLOUT)
    expect.soft(left[2].id).not.toBe(right[2].id)
    expect.soft(left[2].id).not.toBe(abandoned.id)
    expect(right[2].id).not.toBe(abandoned.id)
  })

  it('reads A prefix, B prefix, then C own records exactly once across two history_base hops', () => {
    const { dir, a, b } = sessionsTree()
    const c = continuation(b, 5531)
    const expected = [...prefixes(a, b).prompts, C_PROMPT]
    const rows = conversation(surface, c, dir)
    expect(rows.map(({ prompt }) => prompt)).toEqual(expected)
    expect(new Set(rows.map(({ id }) => id)).size).toBe(expected.length)
  })

  it('preserves identities from both ancestors when a second continuation is read', () => {
    const { dir, a, b } = sessionsTree()
    const c = continuation(b, 5531)
    const before = conversation(surface, b, dir)
    const after = conversation(surface, c, dir)
    const { aRows, prompts } = prefixes(a, b)
    expect(after.map(({ prompt }) => prompt)).toEqual([...prompts, C_PROMPT])
    expect.soft(after.slice(0, 2).map(({ id }) => id)).toEqual(aRows.map(({ id }) => id))
    expect.soft(after.slice(2, 5)).toEqual(before.slice(2, 5))
    expect.soft(after[2].id).toContain(B_ROLLOUT)
    expect(after[5].id).toContain(C_ROLLOUT)
  })

  it('cuts back into A when C branches before B session_meta, without carrying B history', () => {
    const { dir, a, b } = sessionsTree()
    // Ordinal 5319 lives in A, earlier than B's session_meta at 5455.
    // The thread reference must resolve the ancestor that actually owns the cut.
    const c = continuation(a, 5319)
    const original = parseCodexTrace(linesOf(a))[0]
    const rows = conversation(surface, c, dir)
    expect(rows.map(({ prompt }) => prompt)).toEqual([original.prompt, C_PROMPT])
    expect.soft(rows[0].id).toBe(original.id)
    expect.soft(rows[1].id).toContain(C_ROLLOUT)
    expect(rows[1].id).not.toBe(conversation(surface, b, dir)[2].id)
  })

  it.each(['a', 'b'] as const)('refuses the entire inherited history when required base %s is unavailable', (missing) => {
    const tree = sessionsTree()
    const c = continuation(tree.b, 5531)
    rmSync(tree[missing])
    // An incomplete walk must not silently present B as a complete root.
    expect.soft(codexBaseChain(c, { sessionsDir: tree.dir })).toEqual([])
    const rows = conversation(surface, c, tree.dir)
    expect(rows.map(({ prompt }) => prompt)).toEqual([C_PROMPT])
  })

  it.each(['a', 'b'] as const)('retries after required base %s arrives instead of caching the failed read', (missing) => {
    const tree = sessionsTree()
    const c = continuation(tree.b, 5531)
    const expected = [...prefixes(tree.a, tree.b).prompts, C_PROMPT]
    const bytes = readFileSync(tree[missing])
    rmSync(tree[missing])
    expect.soft(conversation(surface, c, tree.dir).map(({ prompt }) => prompt)).toEqual([C_PROMPT])
    writeFileSync(tree[missing], bytes)
    const recovered = conversation(surface, c, tree.dir)
    expect(recovered.map(({ prompt }) => prompt)).toEqual(expected)
    expect(new Set(recovered.map(({ id }) => id)).size).toBe(expected.length)
  })

  it('retries a temporarily invalid ancestor cut after the same header is repaired', () => {
    const { dir, a, b } = sessionsTree()
    const original = readFileSync(b, 'utf8')
    const [first, ...rest] = linesOf(b)
    const header = JSON.parse(first)
    const invalid = {
      ...header,
      payload: {
        ...header.payload,
        history_base: {
          ...header.payload.history_base,
          end_byte_offset: header.payload.history_base.end_byte_offset + 7
        }
      }
    }
    writeFileSync(b, [JSON.stringify(invalid), ...rest, ''].join('\n'))
    // Build C after the invalid header, so its own byte cut is still valid.
    const c = continuation(b, 5531)
    expect.soft(codexBaseChain(c, { sessionsDir: dir })).toEqual([])
    expect.soft(conversation(surface, c, dir).map(({ prompt }) => prompt)).toEqual([C_PROMPT])
    writeFileSync(b, original)
    // +7 has the same digit count, so repairing B does not move C's cut.
    expect(conversation(surface, c, dir).map(({ prompt }) => prompt)).toEqual([
      ...prefixes(a, b).prompts,
      C_PROMPT
    ])
  })
})
