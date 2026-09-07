// THE MARK MIGRATION, ON A SYNTHETIC CORPUS — one-stream T4.
//
// The real run touches the owner's 279 ledgers once and is not repeatable, so
// every way it can be wrong is pinned here instead, on a turns directory and a
// transcript this file builds:
//
//   · a legacy record with NO uuid lands on the digest the STREAM computes for
//     the same exchange — asserted against trace-blocks' own parse of a real
//     transcript, not against a copy of the formula (T1 counted 39 of these
//     and could not place one);
//   · the two unplaceable pins have a shape, and it is "the index names no
//     record" — reported by terminal and index, never guessed onto a
//     neighbouring row;
//   · a second run writes ZERO lines;
//   · a mark that reaches no row comes back as an orphan with a reason.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPlan,
  migrationIdentityOf,
  planCard,
  verifyPlan,
  type CardSource
} from '../src/main/mark-migration'
import { readMarks } from '../src/main/marks'
import { parseClaudeTrace } from '../src/shared/trace-blocks'
import type { TurnRecord } from '../src/shared/turn'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mark-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const marksDir = (): string => path.join(dir, 'marks')

function record(partial: Partial<TurnRecord> & { index: number; prompt: string }): TurnRecord {
  return {
    reply: 'r',
    startedAt: 1_000 + partial.index,
    endedAt: 2_000 + partial.index,
    ...partial
  } as TurnRecord
}

function source(partial: Partial<CardSource> = {}): CardSource {
  return {
    terminalId: 'term-1',
    records: [],
    pins: [],
    forks: [],
    ...partial
  }
}

/** A minimal Claude transcript: one user/assistant pair per turn, NO uuids on
 *  the user messages, which is what a pre-uuid legacy file looks like. */
function legacyTranscript(prompts: readonly string[]): string[] {
  const lines: string[] = []
  for (const [at, prompt] of prompts.entries()) {
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: new Date(1_700_000_000_000 + at * 1000).toISOString(),
        message: { role: 'user', content: prompt }
      })
    )
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(1_700_000_000_500 + at * 1000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: `reply ${at}` }] }
      })
    )
  }
  return lines
}

describe('planCard — where each mark lands', () => {
  it('places a title and a seenAt on the record uuid', () => {
    const plan = planCard(
      source({
        records: [
          record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First' }),
          record({ index: 2, prompt: 'b', uuid: 'u-2', seenAt: 555 })
        ]
      })
    )
    expect(plan.patches).toEqual([
      { identity: 'u-1', title: 'First' },
      { identity: 'u-2', seenAt: 555 }
    ])
    expect(plan.counts.titles).toBe(1)
    expect(plan.counts.seenAt).toBe(1)
    expect(plan.counts.derivedIdentities).toBe(0)
  })

  it('carries scrollLine as the mark anchor — /turns reads it back as scrollLine', () => {
    const plan = planCard(
      source({ records: [record({ index: 1, prompt: 'a', uuid: 'u-1', scrollLine: 4210 })] })
    )
    expect(plan.patches).toEqual([{ identity: 'u-1', anchor: 4210 }])
    expect(plan.counts.anchors).toBe(1)
  })

  it('writes ONE patch per identity, not one per field', () => {
    const plan = planCard(
      source({
        records: [record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'T', seenAt: 9 })],
        pins: [{ version: 3, atIndex: 1 }]
      })
    )
    expect(plan.patches).toEqual([{ identity: 'u-1', title: 'T', seenAt: 9, pin: 3 }])
    expect(plan.counts.marks).toBe(1)
  })

  it('a record with no uuid is placed on the derived digest, not dropped', () => {
    const plan = planCard(
      source({ records: [record({ index: 7, prompt: 'legacy prompt', title: 'Old title' })] })
    )
    expect(plan.counts.derivedIdentities).toBe(1)
    expect(plan.patches).toHaveLength(1)
    expect(plan.patches[0].identity).toMatch(/^claude-7-[0-9a-f]{8}$/)
    expect(plan.unplaceable).toEqual([])
  })
})

describe('planCard — the derived identity is the STREAM s, not a second formula', () => {
  it('a legacy title lands on the identity trace-blocks assigns the same exchange', () => {
    const prompts = ['first legacy prompt', 'second legacy prompt']
    const blocks = parseClaudeTrace(legacyTranscript(prompts))
    expect(blocks).toHaveLength(2)
    // Every block of a pre-uuid file carries the derived digest.
    expect(blocks[0].id).toMatch(/^claude-1-/)

    const plan = planCard(
      source({
        records: prompts.map((prompt, at) =>
          record({ index: at + 1, prompt, title: `title ${at}` })
        )
      })
    )
    expect(plan.patches.map((patch) => patch.identity)).toEqual(blocks.map((block) => block.id))
  })

  it('migrationIdentityOf prefers the uuid, exactly as the stream does', () => {
    expect(migrationIdentityOf(record({ index: 1, prompt: 'a', uuid: 'u-1' }))).toBe('u-1')
  })
})

describe('planCard — pins and forks', () => {
  it('an atUuid pin anchors on the uuid without consulting the index', () => {
    const plan = planCard(
      source({
        records: [record({ index: 1, prompt: 'a', uuid: 'u-1' })],
        pins: [{ version: 2, atIndex: 99, atUuid: 'u-1' }]
      })
    )
    expect(plan.patches).toEqual([{ identity: 'u-1', pin: 2 }])
    expect(plan.unplaceable).toEqual([])
  })

  it('a legacy pin resolves through the record at that index', () => {
    const plan = planCard(
      source({
        records: [record({ index: 4, prompt: 'a', uuid: 'u-4' })],
        pins: [{ version: 1, atIndex: 4 }]
      })
    )
    expect(plan.patches).toEqual([{ identity: 'u-4', pin: 1 }])
    expect(plan.counts.pins).toBe(1)
  })

  it('the unplaceable pin is named by terminal and index, never guessed', () => {
    const plan = planCard(
      source({
        terminalId: 'card-a',
        records: [record({ index: 1, prompt: 'a', uuid: 'u-1' })],
        pins: [{ version: 5, atIndex: 812 }]
      })
    )
    expect(plan.patches).toEqual([])
    expect(plan.counts.pins).toBe(0)
    expect(plan.unplaceable).toHaveLength(1)
    expect(plan.unplaceable[0]).toMatchObject({
      terminalId: 'card-a',
      kind: 'pin',
      index: 812
    })
    expect(plan.unplaceable[0].reason).toContain('812')
  })

  it('a fork mark lands on the SOURCE card at the forked turn', () => {
    const plan = planCard(
      source({
        records: [record({ index: 2, prompt: 'a', uuid: 'u-2' })],
        forks: [{ child: 'child-terminal-id', turnIndex: 2 }]
      })
    )
    expect(plan.patches).toEqual([{ identity: 'u-2', fork: 'child-terminal-id' }])
    expect(plan.counts.forks).toBe(1)
  })

  it('a fork past the end of the ledger is reported, not attached to the tail', () => {
    const plan = planCard(
      source({
        terminalId: 'card-b',
        records: [record({ index: 1, prompt: 'a', uuid: 'u-1' })],
        forks: [{ child: 'child-terminal-id', turnIndex: 40 }]
      })
    )
    expect(plan.patches).toEqual([])
    expect(plan.unplaceable).toMatchObject([{ terminalId: 'card-b', kind: 'fork', index: 40 }])
  })
})

describe('applyPlan — the ledger after the run', () => {
  it('writes the marks through marks.ts and they read back folded', () => {
    const plan = planCard(
      source({
        records: [
          record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First', seenAt: 42 }),
          record({ index: 2, prompt: 'b', uuid: 'u-2', title: 'Second' })
        ]
      })
    )
    const applied = applyPlan(plan, { dir: marksDir() })
    expect(applied).toMatchObject({ written: 2, unchanged: 0, failures: [] })

    const marks = readMarks('term-1', { dir: marksDir() })
    expect(marks.get('u-1')).toMatchObject({ title: 'First', seenAt: 42 })
    expect(marks.get('u-2')).toMatchObject({ title: 'Second' })
  })

  it('IS IDEMPOTENT — a second run appends not one byte', () => {
    const plan = planCard(
      source({
        records: [record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First' })],
        pins: [{ version: 1, atIndex: 1 }]
      })
    )
    expect(applyPlan(plan, { dir: marksDir() }).written).toBe(1)
    const file = path.join(marksDir(), 'term-1.jsonl')
    const afterFirst = readFileSync(file, 'utf8')

    const second = applyPlan(plan, { dir: marksDir() })
    expect(second).toMatchObject({ written: 0, unchanged: 1, failures: [] })
    expect(readFileSync(file, 'utf8')).toBe(afterFirst)
  })

  it('writes only the NOVEL field when the ledger already holds the rest', () => {
    const first = planCard(
      source({ records: [record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First' })] })
    )
    applyPlan(first, { dir: marksDir() })
    const second = planCard(
      source({ records: [record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First', seenAt: 9 })] })
    )
    expect(applyPlan(second, { dir: marksDir() }).written).toBe(1)

    const lines = readFileSync(path.join(marksDir(), 'term-1.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1])).toMatchObject({ identity: 'u-1', seenAt: 9 })
    expect(JSON.parse(lines[1]).title).toBeUndefined()
  })

  it('a refused terminal id costs its marks and never the run', () => {
    const plan = planCard(
      source({
        terminalId: '../escape',
        records: [record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First' })]
      })
    )
    const applied = applyPlan(plan, { dir: marksDir() })
    expect(applied.written).toBe(0)
    expect(applied.failures).toHaveLength(1)
    expect(applied.failures[0].error).toContain('refusing unusable terminal id')
    expect(existsSync(path.join(marksDir(), '..', 'escape.jsonl'))).toBe(false)
  })

  it('never writes conversation text — the plan carries no prompt or reply', () => {
    const plan = planCard(
      source({ records: [record({ index: 1, prompt: 'secret prompt', uuid: 'u-1', title: 'T' })] })
    )
    applyPlan(plan, { dir: marksDir() })
    const written = readFileSync(path.join(marksDir(), 'term-1.jsonl'), 'utf8')
    expect(written).not.toContain('secret prompt')
    expect(written).not.toContain('"reply"')
  })
})

describe('verifyPlan — the read-back through the stream', () => {
  const plan = () =>
    planCard(
      source({
        records: [
          record({ index: 1, prompt: 'a', uuid: 'u-1', title: 'First' }),
          record({ index: 2, prompt: 'b', uuid: 'u-2', title: 'Second' })
        ]
      })
    )

  it('says nothing when every migrated mark is on a row', async () => {
    const orphans = await verifyPlan(plan(), {
      checkpointsOf: async () => ({ checkpoints: [{ identity: 'u-1' }, { identity: 'u-2' }] })
    })
    expect(orphans).toEqual([])
  })

  it('names the identity the stream cannot place, with a reason', async () => {
    const orphans = await verifyPlan(plan(), {
      checkpointsOf: async () => ({ checkpoints: [{ identity: 'u-1' }] })
    })
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ terminalId: 'term-1', identity: 'u-2' })
    expect(orphans[0].reason).toContain('1-row stream')
  })

  it('a card with no walkable transcript says SO rather than blaming the mark', async () => {
    const orphans = await verifyPlan(plan(), { checkpointsOf: async () => ({ checkpoints: [] }) })
    expect(orphans).toHaveLength(2)
    expect(orphans[0].reason).toContain('no walkable transcript')
  })

  it('a stream that throws yields orphans, never a failed migration', async () => {
    const orphans = await verifyPlan(plan(), {
      checkpointsOf: async () => {
        throw new Error('chain unreadable')
      }
    })
    expect(orphans).toHaveLength(2)
    expect(orphans[0].reason).toContain('chain unreadable')
  })
})

describe('the whole run over a synthetic turns directory', () => {
  it('migrates every card, reports the unplaceable, and verifies the rest', async () => {
    const cards: CardSource[] = [
      source({
        terminalId: 'card-one',
        records: [
          record({ index: 1, prompt: 'p1', uuid: 'u-1', title: 'One' }),
          record({ index: 2, prompt: 'p2', uuid: 'u-2', seenAt: 7 })
        ],
        pins: [{ version: 1, atIndex: 2 }]
      }),
      source({
        terminalId: 'card-two',
        // The legacy shape: no uuids anywhere.
        records: [record({ index: 1, prompt: 'legacy', title: 'Legacy title' })],
        pins: [{ version: 4, atIndex: 900 }],
        forks: [{ child: 'card-one', turnIndex: 900 }]
      })
    ]
    const plans = cards.map(planCard)
    const totals = plans.reduce(
      (sum, plan) => ({
        marks: sum.marks + plan.counts.marks,
        unplaceable: sum.unplaceable + plan.unplaceable.length
      }),
      { marks: 0, unplaceable: 0 }
    )
    expect(totals).toEqual({ marks: 3, unplaceable: 2 })

    for (const plan of plans) expect(applyPlan(plan, { dir: marksDir() }).failures).toEqual([])
    expect(readMarks('card-one', { dir: marksDir() }).size).toBe(2)
    expect(readMarks('card-two', { dir: marksDir() }).size).toBe(1)

    // The stream places card-one entirely and knows nothing of card-two.
    const orphans = (
      await Promise.all(
        plans.map((plan) =>
          verifyPlan(plan, {
            checkpointsOf: async (terminalId) => ({
              checkpoints:
                terminalId === 'card-one' ? [{ identity: 'u-1' }, { identity: 'u-2' }] : []
            })
          })
        )
      )
    ).flat()
    expect(orphans.map((orphan) => orphan.terminalId)).toEqual(['card-two'])
  })
})
