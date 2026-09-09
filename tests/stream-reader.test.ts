// ONE STREAM, T1 — the reader's gates (docs/site/one-stream-2026-09-07.html).
//
// The load-bearing claims, each of which is a past incident:
//   · the ordinal runs through a compaction instead of restarting at 1 (the
//     400+ checkpoints that went unaddressable);
//   · a chain member with no transcript is REPORTED, never thrown (the
//     2026-09-06 cap, which made history unreachable in silence);
//   · the derived index EXTENDS on append and REBUILDS on shrink, the same
//     contract trace.ts's byte cache follows.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStreamReader } from '../src/main/stream'
import { claudeStreamChain, nodeLineageIds } from '../src/main/stream-chain'
import { TraceReader } from '../src/main/trace'
import { WorkspaceStore } from '../src/main/store'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import { parseClaudeTraceDocument } from '../src/shared/trace-blocks'
import type { StreamChain } from '../src/main/stream-chain'
import type { TraceDocument } from '../src/main/trace'

const T0 = Date.parse('2026-09-06T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

/** A real Claude prompt record — the shape tests/trace-blocks.test.ts uses. */
const prompt = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: iso(ms),
    message: { role: 'user', content: text }
  })

const reply = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })

/** The machine-readable join a /compact writes at the head of the new file. */
const boundary = (pre = 120_000, post = 9_000): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post }
  })

/** A three-file chain: two turns, rotate, two turns, rotate, one turn. */
function chainLines(): { s1: string[]; s2: string[]; s3: string[] } {
  return {
    s1: [
      prompt('u1', 'first ask', T0),
      reply('a1', 'one', T0 + 500),
      prompt('u2', 'second ask', T0 + 1000),
      reply('a2', 'two', T0 + 1500)
    ],
    s2: [
      boundary(),
      prompt('u3', 'third ask', T0 + 2000),
      reply('a3', 'three', T0 + 2500),
      prompt('u4', 'fourth ask', T0 + 3000),
      reply('a4', 'four', T0 + 3500)
    ],
    s3: [boundary(), prompt('u5', 'fifth ask', T0 + 4000), reply('a5', 'five', T0 + 4500)]
  }
}

function documentOver(byFile: Record<string, string[]>) {
  return async (file: string): Promise<TraceDocument> => {
    const lines = byFile[file]
    if (lines === undefined) throw new Error(`ENOENT: ${file}`)
    const parsed = parseClaudeTraceDocument(lines)
    return { ...parsed, bytesRead: lines.join('\n').length }
  }
}

function chainOf(
  files: { sessionId: string; file: string }[],
  missing: StreamChain['missing'] = [],
  declared = false
) {
  return async (): Promise<StreamChain> => ({
    files: files.map((f) => ({
      ...f,
      kind: 'claude' as const,
      ...(declared ? { declared: true as const } : {})
    })),
    missing
  })
}

describe('createStreamReader — one chain, one ordinal', () => {
  const lines = chainLines()
  const files = { 's1.jsonl': lines.s1, 's2.jsonl': lines.s2, 's3.jsonl': lines.s3 }
  const reader = createStreamReader({
    chainOf: chainOf([
      { sessionId: 's1', file: 's1.jsonl' },
      { sessionId: 's2', file: 's2.jsonl' },
      { sessionId: 's3', file: 's3.jsonl' }
    ]),
    documentOf: documentOver(files),
    exists: () => true
  })

  it('numbers the WHOLE chain 1..N — the ordinal never restarts at a compaction', async () => {
    const { entries, missing } = await reader.index('t1')
    expect(missing).toEqual([])
    expect(entries.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4, 5])
    // Each file still counts its own T1..Tn internally; that numbering is
    // exactly what made 400+ checkpoints unaddressable, and it is gone here.
    expect(entries.map((entry) => entry.identity)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5'])
    expect(entries.map((entry) => entry.file)).toEqual([
      's1.jsonl',
      's1.jsonl',
      's2.jsonl',
      's2.jsonl',
      's3.jsonl'
    ])
  })

  it('marks the first block after each boundary, and nothing else', async () => {
    const { entries } = await reader.index('t1')
    expect(entries.map((entry) => entry.compacted)).toEqual([false, false, true, false, true])
  })

  it('carries identity, timestamps and a head-capped prompt — never the prompt', async () => {
    const { entries } = await reader.index('t1')
    expect(entries[0]).toEqual({
      identity: 'u1',
      ordinal: 1,
      startedAt: T0,
      endedAt: T0 + 500,
      promptHead: 'first ask',
      compacted: false,
      file: 's1.jsonl'
    })
  })

  it('windows blocks by identity, across the file seam', async () => {
    const page = await reader.blocks('t1', { after: 'u2', limit: 2 })
    expect(page.total).toBe(5)
    expect(page.blocks.map((block) => [block.id, block.ordinal])).toEqual([
      ['u3', 3],
      ['u4', 4]
    ])
    expect(page.blocks[0].compacted).toBe(true)
    expect(page.blocks[0].sessionId).toBe('s2')
    expect(page.blocks[0].reply).toBe('three')
  })

  it('says so when the cursor names an identity the stream does not hold', async () => {
    const page = await reader.blocks('t1', { after: 'nope' })
    expect(page.unknownAfter).toBe(true)
    expect(page.blocks).toEqual([])
  })

  it('starts at the oldest block when no cursor is given', async () => {
    const page = await reader.blocks('t1', { limit: 1 })
    expect(page.blocks.map((block) => block.ordinal)).toEqual([1])
  })

  it('tail is the last block, open (Claude writes no end-of-turn into a block)', async () => {
    const tail = await reader.tail('t1')
    expect(tail.open).toBe(true)
    expect(tail.block?.ordinal).toBe(5)
    expect(tail.block?.id).toBe('u5')
  })
})

describe('createStreamReader — a missing file is reported, never thrown', () => {
  const lines = chainLines()

  it('keeps the reachable history and names the absent predecessor', async () => {
    const reader = createStreamReader({
      chainOf: chainOf(
        [
          { sessionId: 's1', file: 's1.jsonl' },
          { sessionId: 's3', file: 's3.jsonl' }
        ],
        [{ sessionId: 's2', file: 's2.jsonl', reason: 'no-transcript' }]
      ),
      documentOf: documentOver({ 's1.jsonl': lines.s1, 's3.jsonl': lines.s3 }),
      exists: () => true
    })
    const { entries, missing } = await reader.index('t1')
    expect(missing).toEqual([{ sessionId: 's2', file: 's2.jsonl', reason: 'no-transcript' }])
    // The ordinal is over what can be READ. A shorter true history beats a
    // fabricated long one — and the gap is stated, not silent.
    expect(entries.map((entry) => [entry.identity, entry.ordinal])).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['u5', 3]
    ])
  })

  it('a file that vanishes mid-read is reported, and the rest still renders', async () => {
    const reader = createStreamReader({
      chainOf: chainOf([
        { sessionId: 's1', file: 's1.jsonl' },
        { sessionId: 's2', file: 'gone.jsonl' }
      ]),
      documentOf: async (file) =>
        file === 'gone.jsonl'
          ? { blocks: [], markers: [], bytesRead: 0 }
          : documentOver({ 's1.jsonl': lines.s1 })(file),
      exists: (file) => file !== 'gone.jsonl'
    })
    const { entries, missing } = await reader.index('t1')
    expect(entries).toHaveLength(2)
    expect(missing).toEqual([{ sessionId: 's2', file: 'gone.jsonl', reason: 'no-transcript' }])
  })

  it('a read that throws costs that file, not the chain', async () => {
    const reader = createStreamReader({
      chainOf: chainOf([
        { sessionId: 's1', file: 's1.jsonl' },
        { sessionId: 's2', file: 'boom.jsonl' }
      ]),
      documentOf: documentOver({ 's1.jsonl': lines.s1 }),
      exists: () => true
    })
    const { entries, missing } = await reader.index('t1')
    expect(entries).toHaveLength(2)
    expect(missing).toEqual([{ sessionId: 's2', file: 'boom.jsonl', reason: 'unreadable' }])
  })

  it('an unresolvable chain is an empty stream with a reason, not an exception', async () => {
    const reader = createStreamReader({
      chainOf: async () => {
        throw new Error('workspace unreadable')
      },
      documentOf: documentOver({})
    })
    const { entries, missing } = await reader.index('t1')
    expect(entries).toEqual([])
    expect(missing).toEqual([{ sessionId: 't1', file: '', reason: 'unreadable' }])
  })
})

describe('createStreamReader — the index cache, keyed by (file, byte offset)', () => {
  /**
   * The proof is deliberately blunt: the fake hands back a REWRITTEN first
   * block on the append. A reader that re-walked the file would show the
   * rewrite; one that spliced past its cached prefix cannot. That is the
   * whole contract — an append re-derives the open tail and what follows it,
   * never the history in front (the O(n²) trace.ts already refuses to pay).
   */
  const block = (id: string, index: number, prompt: string) => ({
    id,
    index,
    prompt,
    reply: '',
    activity: [],
    startedAt: T0,
    endedAt: T0
  })

  const stages: TraceDocument[] = [
    { blocks: [block('u1', 1, 'original one'), block('u2', 2, 'two')], markers: [], bytesRead: 100 },
    {
      blocks: [block('u1', 1, 'REWRITTEN'), block('u2', 2, 'two'), block('u3', 3, 'three')],
      markers: [],
      bytesRead: 200
    },
    { blocks: [block('u1', 1, 'REWRITTEN')], markers: [], bytesRead: 50 }
  ]

  it('extends on append and rebuilds on shrink', async () => {
    let stage = 0
    const reader = createStreamReader({
      chainOf: chainOf([{ sessionId: 's1', file: 's1.jsonl' }]),
      documentOf: async () => stages[stage],
      exists: () => true
    })

    expect((await reader.index('t1')).entries.map((e) => e.promptHead)).toEqual([
      'original one',
      'two'
    ])

    stage = 1
    // Spliced: the cached prefix is kept verbatim, so the rewrite is invisible.
    expect((await reader.index('t1')).entries.map((e) => e.promptHead)).toEqual([
      'original one',
      'two',
      'three'
    ])

    stage = 2
    // A shrink (a /rewind truncation) voids everything derived from the
    // removed bytes — rebuild, exactly as trace.ts's own cache does.
    expect((await reader.index('t1')).entries.map((e) => e.promptHead)).toEqual(['REWRITTEN'])
  })

  it('an unchanged offset re-derives nothing at all', async () => {
    let document = stages[0]
    const reader = createStreamReader({
      chainOf: chainOf([{ sessionId: 's1', file: 's1.jsonl' }]),
      documentOf: async () => document,
      exists: () => true
    })
    await reader.index('t1')
    document = { ...stages[1], bytesRead: stages[0].bytesRead }
    expect((await reader.index('t1')).entries.map((e) => e.promptHead)).toEqual([
      'original one',
      'two'
    ])
  })
})

describe('createStreamReader — the derived index over real files', () => {
  /** A real project dir + session file, read through TraceReader's own cache. */
  function bed(): { dir: string; reader: TraceReader; cwd: string } {
    const base = mkdtempSync(path.join(tmpdir(), 'one-stream-'))
    const cwd = '/work/repo'
    const dir = path.join(base, claudeProjectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'one-stream-ws-')))
    return { dir, cwd, reader: new TraceReader(store, { projectsDir: base }) }
  }

  it('extends on append (untouched rows keep their identity) and rebuilds on shrink', async () => {
    const { dir, reader: trace } = bed()
    const file = path.join(dir, 's1.jsonl')
    const head = [prompt('u1', 'first ask', T0), reply('a1', 'one', T0 + 500)]
    writeFileSync(file, `${head.join('\n')}\n`)

    const stream = createStreamReader({
      chainOf: chainOf([{ sessionId: 's1', file }]),
      documentOf: (target, kind) => trace.documentOf(target, kind)
    })

    const first = await stream.index('t1')
    expect(first.entries.map((entry) => entry.ordinal)).toEqual([1])

    appendFileSync(file, `${prompt('u2', 'second ask', T0 + 1000)}\n`)
    const grown = await stream.index('t1')
    expect(grown.entries.map((entry) => entry.identity)).toEqual(['u1', 'u2'])

    // A shrink is a /rewind truncation: everything derived from the removed
    // bytes is void, so the file's index is rebuilt rather than extended.
    writeFileSync(file, `${prompt('u1', 'first ask', T0)}\n`)
    const shrunk = await stream.index('t1')
    expect(shrunk.entries.map((entry) => entry.identity)).toEqual(['u1'])
    rmSync(path.dirname(dir), { recursive: true, force: true })
  })

  it('walks a real two-file lineage as one stream through claudeStreamChain', async () => {
    const { dir, cwd, reader: trace } = bed()
    const lines = chainLines()
    writeFileSync(path.join(dir, 'sess-1.jsonl'), `${lines.s1.join('\n')}\n`)
    writeFileSync(path.join(dir, 'sess-2.jsonl'), `${lines.s3.join('\n')}\n`)
    const node = {
      id: 't1',
      cwd,
      command: 'claude',
      claudeSessionId: 'sess-2',
      sessionLineage: ['sess-1']
    }
    const projectsDir = path.dirname(dir)
    const stream = createStreamReader({
      chainOf: () => claudeStreamChain(node, { projectsDir, lineageIds: nodeLineageIds }),
      documentOf: (target, kind) => trace.documentOf(target, kind)
    })
    const { entries, missing } = await stream.index('t1')
    expect(missing).toEqual([])
    expect(entries.map((entry) => [entry.identity, entry.ordinal, entry.compacted])).toEqual([
      ['u1', 1, false],
      ['u2', 2, false],
      ['u5', 3, true]
    ])
    rmSync(projectsDir, { recursive: true, force: true })
  })

  it('reports a recorded session id whose transcript is gone', async () => {
    const { dir, cwd } = bed()
    writeFileSync(path.join(dir, 'sess-2.jsonl'), `${chainLines().s3.join('\n')}\n`)
    const chain = await claudeStreamChain(
      {
        id: 't1',
        cwd,
        command: 'claude',
        claudeSessionId: 'sess-2',
        sessionLineage: ['deleted-1']
      },
      { projectsDir: path.dirname(dir), lineageIds: nodeLineageIds }
    )
    expect(chain.files.map((f) => f.sessionId)).toEqual(['sess-2'])
    expect(chain.missing).toEqual([
      { sessionId: 'deleted-1', file: path.join(dir, 'deleted-1.jsonl'), reason: 'no-transcript' }
    ])
    rmSync(path.dirname(dir), { recursive: true, force: true })
  })
})

/**
 * REPLAY FROM THE CURSOR, NOT FROM THE START OF THE CHAIN (D6, T5 QA
 * 2026-09-07).
 *
 * Every read re-walked the whole lineage — nine transcripts on the owner's
 * busiest card — although the persisted snapshot already held every checkpoint
 * in the eight behind the cursor. The preconditions are strict and the READER
 * checks them, so the fast path can only ever be an optimisation of the answer
 * the slow path would have given.
 */
describe('createStreamReader — resuming from the cursor', () => {
  const lines = chainLines()
  const files = { 's1.jsonl': lines.s1, 's2.jsonl': lines.s2, 's3.jsonl': lines.s3 }
  const chain = [
    { sessionId: 's1', file: 's1.jsonl' },
    { sessionId: 's2', file: 's2.jsonl' },
    { sessionId: 's3', file: 's3.jsonl' }
  ]

  /** Every file's size, as the fixture writes it — the coverage a snapshot
   *  built from a full read would claim. */
  const sizeOf = (file: string): number | null => {
    const lines = files[file as keyof typeof files]
    return lines === undefined ? null : lines.join('\n').length
  }

  /** A reader over the three-file chain, counting every document it reads. */
  function counted(over: (file: string) => number | null = sizeOf) {
    const read: string[] = []
    const documentOf = documentOver(files)
    const reader = createStreamReader({
      chainOf: chainOf(chain, [], true),
      documentOf: async (file) => {
        read.push(file)
        return documentOf(file)
      },
      exists: (file) => over(file) !== null,
      sizeOf: over
    })
    return { reader, read: () => read }
  }

  /** A snapshot that covers every predecessor to its current last byte. */
  const holdsAll = { cursorFile: 's3.jsonl', coveredBytes: (file: string) => sizeOf(file) ?? undefined }

  it('reads the cursor’s file alone when the caller holds the rest', async () => {
    const { reader, read } = counted()
    const result = await reader.lines('t1', holdsAll)
    expect(read()).toEqual(['s3.jsonl'])
    expect(result.resumed).toBe(true)
    // Every chain member is still NAMED — a cursor is addressed against a
    // file, and one that vanished from the answer could not be repaired.
    expect(result.files.map((entry) => entry.file)).toEqual([
      's1.jsonl',
      's2.jsonl',
      's3.jsonl'
    ])
    expect(result.lines.map((line) => line.entry?.identity)).toEqual(['u5'])
  })

  it('refuses when the cursor is not the chain’s newest transcript', async () => {
    const { reader, read } = counted()
    const result = await reader.lines('t1', {
      cursorFile: 's2.jsonl',
      coveredBytes: (file: string) => sizeOf(file) ?? undefined
    })
    expect(read()).toEqual(['s1.jsonl', 's2.jsonl', 's3.jsonl'])
    expect(result.resumed).toBeUndefined()
    expect(result.lines).toHaveLength(5)
  })

  it('refuses when a member in front of the cursor is not held at all', async () => {
    const { reader, read } = counted()
    const result = await reader.lines('t1', {
      cursorFile: 's3.jsonl',
      coveredBytes: (file) => (file === 's1.jsonl' ? undefined : (sizeOf(file) ?? undefined))
    })
    expect(read()).toEqual(['s1.jsonl', 's2.jsonl', 's3.jsonl'])
    expect(result.resumed).toBeUndefined()
  })

  // THE REVIEW'S C1. `holds(file)` used to answer "the snapshot has SOME
  // checkpoint out of this file", which is true of a predecessor that has
  // GROWN since — a `claude --resume` into an earlier session appends to a
  // non-tail chain member. Those exchanges would then never be read, on this
  // pass or any later one, because the same fast path is taken every time.
  it('refuses when a member in front of the cursor has GROWN past what we hold', async () => {
    const { reader, read } = counted()
    const result = await reader.lines('t1', {
      cursorFile: 's3.jsonl',
      // The snapshot was built from half of s1 — it grew after the cursor moved on.
      coveredBytes: (file) =>
        file === 's1.jsonl'
          ? Math.floor((sizeOf(file) as number) / 2)
          : (sizeOf(file) ?? undefined)
    })
    expect(read()).toEqual(['s1.jsonl', 's2.jsonl', 's3.jsonl'])
    expect(result.resumed).toBeUndefined()
    // …and the answer is the full one, so nothing was lost.
    expect(result.lines.map((line) => line.entry?.identity)).toEqual([
      'u1',
      'u2',
      'u3',
      'u4',
      'u5'
    ])
  })

  // A resumed walk keeps the CHAIN's order for the members it skips, so the
  // one fact it could derive differently is the ⇥ pointer on the cursor file's
  // first block. Holding a row out of that file is what pins it: the refold
  // keeps what the last full walk decided.
  it('refuses when the snapshot holds nothing out of the cursor’s own file', async () => {
    const { reader, read } = counted()
    const result = await reader.lines('t1', {
      cursorFile: 's3.jsonl',
      coveredBytes: (file) => (file === 's3.jsonl' ? undefined : (sizeOf(file) ?? undefined))
    })
    expect(read()).toEqual(['s1.jsonl', 's2.jsonl', 's3.jsonl'])
    expect(result.resumed).toBeUndefined()
  })

  it('still reports a skipped member whose transcript has been deleted', async () => {
    const { reader, read } = counted((file) => (file === 's1.jsonl' ? null : sizeOf(file)))
    const result = await reader.lines('t1', holdsAll)
    expect(read()).toEqual(['s3.jsonl'])
    expect(result.missing).toEqual([
      { sessionId: 's1', file: 's1.jsonl', reason: 'no-transcript' }
    ])
  })

  it('the tail takes its chain-wide ordinal from the index on EVERY path', async () => {
    // The review's C2: stream-service takes `total` from the materialised
    // index on both paths, so the ordinal beside it must come from the same
    // record — the walk's own numbering is contiguous over the blocks still on
    // disk, which is not that space once a rewind has happened.
    const { reader } = counted()
    const full = await reader.tail('t1', { ordinalOf: () => 99 })
    expect(full.block?.ordinal).toBe(99)
  })

  it('the tail takes its chain-wide ordinal from the materialised index', async () => {
    const { reader, read } = counted()
    const tail = await reader.tail('t1', {
      resume: holdsAll,
      ordinalOf: (identity) => (identity === 'u5' ? 5 : undefined)
    })
    expect(read()).toEqual(['s3.jsonl'])
    expect(tail.block?.id).toBe('u5')
    // A suffix walk numbers itself from 1; the index says 5, and the index is
    // the record that saw the whole chain.
    expect(tail.block?.ordinal).toBe(5)
  })

  it('pays for the full walk rather than publishing a half-chain number', async () => {
    const { reader, read } = counted()
    const tail = await reader.tail('t1', { resume: holdsAll, ordinalOf: () => undefined })
    // The suffix is read, the index cannot place it, and the reader falls back.
    expect(read()).toEqual(['s3.jsonl', 's1.jsonl', 's2.jsonl', 's3.jsonl'])
    expect(tail.block?.ordinal).toBe(5)
  })

  it('a resumed tail agrees with an unresumed one, block for block', async () => {
    const { reader } = counted()
    const full = await reader.tail('t1')
    const resumed = await reader.tail('t1', {
      resume: holdsAll,
      ordinalOf: (identity) => (identity === 'u5' ? 5 : undefined)
    })
    expect(resumed.block).toEqual(full.block)
    expect(resumed.open).toBe(full.open)
  })
})
