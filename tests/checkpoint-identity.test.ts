import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HARNESSES } from '../src/main/harness'
import { SessionTurnSync } from '../src/main/session-sync'
import { TurnTracker } from '../src/main/turn-tracker'
import { parseSessionTurns } from '../src/shared/session-turns'
import {
  parseClaudeTrace,
  parseCodexTrace,
  parseCodexTurns,
  parsePiTrace,
  parsePiTurns
} from '../src/shared/trace-blocks'
import type { TraceBlock } from '../src/shared/trace-blocks'
import type { TurnRecord } from '../src/shared/turn'

// REFACTOR STEP 1 (checkpoint-as-identity): TraceBlock and TurnRecord are one
// coordinate space. Not "usually equal" — equal BY CONSTRUCTION, ordinal AND
// identity, for every harness declaring turns: 'file'. The clamp in
// mergeCheckpointRows is the canary; these tests are the fence that keeps it
// a no-op.
//
// The fixture suite alone is not evidence: it only proves the shapes someone
// thought to write down. The real-data sweep below runs the SAME assertion
// over every session file this machine has actually produced.

const T = (s: string): string => `2026-07-22T10:${s}:00.000Z`

const user = (content: unknown, ts: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra })

const assistant = (text: string, ts: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: ts,
    ...extra
  })

const image = (text: string): unknown[] => [
  { type: 'text', text },
  { type: 'image', source: { type: 'base64', data: 'x' } }
]

/** The pair every downstream consumer joins on: ordinal + stable identity. */
interface Identity {
  index: number
  id: string | undefined
}

const recordIds = (records: readonly TurnRecord[]): Identity[] =>
  records.map((r) => ({ index: r.index, id: r.uuid }))

const blockIds = (blocks: readonly TraceBlock[]): Identity[] =>
  blocks.map((b) => ({ index: b.index, id: b.id }))

// ---- the shapes that historically pulled the two counters apart ----

const SHAPES: Record<string, string[]> = {
  'plain exchanges': [
    user('one', T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    assistant('a', T('01')),
    user('two', T('02'), { uuid: 'u2', parentUuid: 'p2' }),
    assistant('b', T('03'))
  ],
  'sibling collapse (string mirror + image record)': [
    user('ask', T('00'), { uuid: 'u1a', parentUuid: 'p1' }),
    user(image('ask'), T('00'), { uuid: 'u1b', parentUuid: 'p1' }),
    assistant('a', T('01'))
  ],
  'image-only submission': [
    user(image('describe this'), T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    assistant('a', T('01'))
  ],
  'noise wrappers between real prompts': [
    user('real one', T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    user('<command-name>/usage</command-name>', T('01'), { uuid: 'n1', parentUuid: 'p2' }),
    user('<local-command-stdout>ok</local-command-stdout>', T('02'), { uuid: 'n2', parentUuid: 'p3' }),
    user('[Request interrupted by user]', T('03'), { uuid: 'n3', parentUuid: 'p4' }),
    user('real two', T('04'), { uuid: 'u2', parentUuid: 'p5' })
  ],
  'tool_result user entries are not prompts': [
    user('ask', T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      timestamp: T('01'),
      uuid: 'tr1',
      parentUuid: 'p1'
    }),
    assistant('a', T('02'))
  ],
  'meta entries are skipped': [
    user('meta text', T('00'), { uuid: 'm1', parentUuid: 'p0', isMeta: true }),
    user('ask', T('01'), { uuid: 'u1', parentUuid: 'p1' })
  ],
  'compact boundary mid-session': [
    user('before', T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: T('01'),
      compactMetadata: { preTokens: 100, postTokens: 10 }
    }),
    user('after', T('02'), { uuid: 'u2', parentUuid: 'p2' })
  ],
  'legacy entries with no uuid': [
    user('no uuid here', T('00')),
    assistant('a', T('01')),
    user('nor here', T('02'))
  ],
  'entries missing a type, blank lines, malformed JSON': [
    '',
    'not json at all',
    JSON.stringify({ message: { content: 'typeless' } }),
    user('ask', T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    '   ',
    assistant('a', T('01'))
  ],
  'assistant text before any prompt': [
    assistant('orphan', T('00')),
    user('ask', T('01'), { uuid: 'u1', parentUuid: 'p1' })
  ]
}

describe('checkpoint identity is ONE coordinate space (claude fixtures)', () => {
  for (const [name, lines] of Object.entries(SHAPES)) {
    it(`${name}: record index+identity === trace-block index+identity`, () => {
      const records = parseSessionTurns(lines)
      const blocks = parseClaudeTrace(lines)
      expect(recordIds(records)).toEqual(blockIds(blocks))
    })
  }

  // turn-tracker's matchPrior carries the Sous title / read marker over on an
  // exact uuid match, with NO prompt check — an identity is a promise that
  // this is the same exchange. A derived identity built from the ordinal
  // alone breaks that promise after a rewind: the new exchange at ordinal N
  // would inherit the rewound one's title.
  it('derived identities distinguish different exchanges at the same ordinal', () => {
    const before = parseSessionTurns([user('old direction', T('00'))])
    const after = parseSessionTurns([user('completely new direction', T('00'))])
    expect(before[0].index).toBe(after[0].index)
    expect(before[0].uuid).not.toBe(after[0].uuid)

    // ...and are stable for the same exchange, so a reconcile still pairs.
    const again = parseSessionTurns([user('old direction', T('05'))])
    expect(again[0].uuid).toBe(before[0].uuid)
  })

  it('never leaves a checkpoint without an identity to join on', () => {
    // A record whose uuid is undefined can pair with no trace block, so it
    // renders as a phantom rail row — the exact failure the clamp masks.
    const lines = SHAPES['legacy entries with no uuid']
    for (const record of parseSessionTurns(lines)) {
      expect(record.uuid).toBeTypeOf('string')
    }
    for (const block of parseClaudeTrace(lines)) {
      expect(block.id).toBeTypeOf('string')
    }
  })
})

// ---- real data: every session file this machine has actually produced ----

function jsonlUnder(root: string, limit: number): string[] {
  if (!existsSync(root)) return []
  const found: { file: string; size: number }[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      try {
        found.push({ file: full, size: statSync(full).size })
      } catch {
        // vanished between readdir and stat — a live agent rotating files
      }
    }
  }
  // Biggest first: the long sessions are the ones that accumulate compacts,
  // image prompts and sibling collapses.
  return found
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((entry) => entry.file)
}

interface RealCorpus {
  harness: 'claude' | 'codex' | 'pi'
  root: string
  limit: number
  records: (lines: string[]) => TurnRecord[]
  blocks: (lines: string[]) => TraceBlock[]
}

const CORPORA: RealCorpus[] = [
  {
    harness: 'claude',
    root: join(homedir(), '.claude', 'projects'),
    limit: 40,
    records: parseSessionTurns,
    blocks: parseClaudeTrace
  },
  {
    harness: 'codex',
    root: join(homedir(), '.codex', 'sessions'),
    limit: 40,
    records: parseCodexTurns,
    blocks: parseCodexTrace
  },
  {
    harness: 'pi',
    root: join(homedir(), '.cookrew', 'pi-sessions'),
    limit: 40,
    records: parsePiTurns,
    blocks: parsePiTrace
  }
]

describe('checkpoint identity holds on REAL session files', () => {
  for (const corpus of CORPORA) {
    it(`${corpus.harness}: every real session agrees on index and identity`, () => {
      const files = jsonlUnder(corpus.root, corpus.limit)
      if (files.length === 0) {
        // A machine without this harness installed. Nothing to prove here;
        // the fixture suite above still runs.
        return
      }
      const diverged: string[] = []
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n')
        const records = recordIds(corpus.records(lines))
        const blocks = blockIds(corpus.blocks(lines))
        if (JSON.stringify(records) !== JSON.stringify(blocks)) {
          const at = records.findIndex(
            (r, i) => blocks[i] === undefined || blocks[i].index !== r.index || blocks[i].id !== r.id
          )
          diverged.push(
            `${file} — records=${records.length} blocks=${blocks.length} first divergence at position ${at}: ` +
              `record=${JSON.stringify(records[at])} block=${JSON.stringify(blocks[at])}`
          )
        }
      }
      expect(diverged).toEqual([])
    })
  }
})

// ---- end to end: the records the app actually stores ----
//
// The parsers agreeing is necessary but not sufficient — what the rail joins
// against is the history SessionTurnSync puts in the TurnTracker. Run a real
// session file through the real pipeline, wired the way the harness registry
// wires it, and compare that against the trace.

describe('SessionTurnSync lands records in the trace index space (real files)', () => {
  for (const corpus of CORPORA) {
    it(`${corpus.harness}: tracker history === trace blocks, via the registry parser`, () => {
      const [file] = jsonlUnder(corpus.root, 1)
      if (file === undefined) return

      const harness = HARNESSES.find((entry) => entry.id === corpus.harness)
      expect(harness?.turns).toBe('file')
      // Contract rule: a 'file' harness wires its OWN parser. Reading it from
      // the registry (rather than importing the function) is what makes this
      // test fail the day someone adds a harness and forgets.
      const parse = harness?.parseTurns
      expect(parse).toBeTypeOf('function')

      const tracker = new TurnTracker(async () => null, null)
      const sync = new SessionTurnSync(tracker, 60_000)
      try {
        sync.watch('term-real', file, parse as (lines: string[]) => TurnRecord[])
        const stored = tracker.history('term-real')
        const blocks = corpus.blocks(readFileSync(file, 'utf8').split('\n'))
        expect(stored.length).toBeGreaterThan(0)
        expect(recordIds(stored)).toEqual(blockIds(blocks))
      } finally {
        sync.dispose()
        tracker.disposeAll()
      }
    })
  }
})
