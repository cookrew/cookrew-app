// THE LINEAGE IS APPEND-ONLY, AND ITS DURABLE COPY IS ATOMIC.
//
// 2026-09-06, fourth recurrence of "I lost my checkpoints": the lineage was
// capped at SESSION_LINEAGE_CAP = 20 and `slice(len - CAP)` DROPPED the oldest
// session id on every rebind past it. The owner's busiest card (Conductor,
// Cookrew Dev) was sitting at exactly 20, so the next compact would have made
// a whole transcript — and every checkpoint in it — unreachable from the rail,
// silently and with no error anywhere.
//
// These are the gates for the fix:
//   L1  25 rebinds, none lost — node array AND the durable spill
//   L2  the spill write is atomic: a crash between temp-write and rename
//       leaves the previous chain intact, and two interleaved appends both
//       survive (the merge re-reads INSIDE the lock)
//   L3  appending an id already recorded is a no-op (idempotent)
//   L4  migration: a node at the old cap gains a spill of what it has, and
//       nothing is rewritten destructively

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LineageSpill } from '../src/main/lineage-spill'
import { withSessionLineage } from '../src/main/session-lineage'
import { unionLineage } from '../src/shared/lineage-spill-format.mjs'

const TERMINAL = '0bd65d5f-89c5-4406-a043-edb01d10bfe8'
const sid = (n: number): string =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'lineage-spill-'))
}

/** One rebind through the real choke point, spilled the way the store does. */
function rebind(
  spill: LineageSpill,
  node: { claudeSessionId?: string | null; sessionLineage?: string[] },
  next: string
): { claudeSessionId?: string | null; sessionLineage?: string[] } {
  const patch = withSessionLineage(node, next)
  spill.record(TERMINAL, [...(patch.sessionLineage ?? []), patch.claudeSessionId ?? ''])
  return patch
}

describe('L1 — 25 rebinds past the old cap and not one id is lost', () => {
  it('keeps every id on the node array (append-only, no slice)', () => {
    const spill = new LineageSpill(freshDir())
    let node: { claudeSessionId?: string | null; sessionLineage?: string[] } = {
      claudeSessionId: sid(0),
      sessionLineage: []
    }
    for (let i = 1; i <= 25; i++) node = rebind(spill, node, sid(i))

    expect(node.claudeSessionId).toBe(sid(25))
    expect(node.sessionLineage).toHaveLength(25)
    expect(node.sessionLineage?.[0]).toBe(sid(0)) // the id the cap used to eat
    expect(node.sessionLineage?.at(-1)).toBe(sid(24))
  })

  it('and every id is in the durable spill, in order, with when it was bound', () => {
    const dir = freshDir()
    const spill = new LineageSpill(dir)
    let node: { claudeSessionId?: string | null; sessionLineage?: string[] } = {
      claudeSessionId: sid(0),
      sessionLineage: []
    }
    for (let i = 1; i <= 25; i++) node = rebind(spill, node, sid(i))

    const record = spill.read(TERMINAL)
    expect(record?.ids).toHaveLength(26)
    expect(record?.ids[0]).toBe(sid(0))
    expect(record?.ids.at(-1)).toBe(sid(25))
    for (const id of record?.ids ?? []) expect(typeof record?.boundAt[id]).toBe('string')

    // The union the rail reads is complete from either side alone.
    expect(unionLineage(spill.idsOf(TERMINAL), node.sessionLineage ?? [])).toHaveLength(26)
    expect(spill.reachable(TERMINAL, node)).toHaveLength(26)
  })

  it('one file per node, 0600, and nothing else left behind', () => {
    const dir = freshDir()
    const spill = new LineageSpill(dir)
    spill.record(TERMINAL, [sid(1), sid(2)])
    expect(readdirSync(dir)).toEqual([`${TERMINAL}.json`])
    const body = JSON.parse(readFileSync(path.join(dir, `${TERMINAL}.json`), 'utf8'))
    expect(body.ids).toEqual([sid(1), sid(2)])
  })
})

describe('L2 — the durable write is atomic', () => {
  it('a crash between the temp write and the rename leaves the old chain readable', () => {
    const dir = freshDir()
    const good = new LineageSpill(dir)
    good.record(TERMINAL, [sid(1), sid(2)])

    const crashing = new LineageSpill(dir, {
      rename: () => {
        throw new Error('simulated crash before rename')
      }
    })
    const result = crashing.record(TERMINAL, [sid(3)])
    expect(result.ok).toBe(false)

    // The previous chain is intact and parseable — never a half-written file.
    expect(good.idsOf(TERMINAL)).toEqual([sid(1), sid(2)])
    expect(existsSync(path.join(dir, `${TERMINAL}.json.tmp`))).toBe(false)
  })

  it('two interleaved appends both survive — the merge re-reads inside the lock', () => {
    const dir = freshDir()
    const file = path.join(dir, `${TERMINAL}.json`)
    const first = new LineageSpill(dir)
    first.record(TERMINAL, [sid(1)])

    // A competing writer lands AFTER our read would have been taken and
    // BEFORE our merge: the classic lost update. The merge must see it.
    const racing = new LineageSpill(dir, {
      beforeMerge: () => {
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            terminalId: TERMINAL,
            ids: [sid(1), sid(9)],
            boundAt: {}
          })
        )
      }
    })
    racing.record(TERMINAL, [sid(2)])

    expect(first.idsOf(TERMINAL)).toEqual([sid(1), sid(9), sid(2)])
  })

  it('a corrupt file is never the reason an id is dropped — it is rebuilt around', () => {
    const dir = freshDir()
    writeFileSync(path.join(dir, `${TERMINAL}.json`), '{ this is not json')
    const spill = new LineageSpill(dir)
    expect(spill.idsOf(TERMINAL)).toEqual([])
    expect(spill.record(TERMINAL, [sid(4)]).ok).toBe(true)
    expect(spill.idsOf(TERMINAL)).toEqual([sid(4)])
  })

  it('refuses a terminal id that is not a plain node id (no path escape)', () => {
    const dir = freshDir()
    const spill = new LineageSpill(dir)
    expect(spill.record('../../etc/passwd', [sid(1)]).ok).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('L3 — appending is idempotent', () => {
  it('re-recording the same chain writes nothing new', () => {
    const dir = freshDir()
    const spill = new LineageSpill(dir)
    spill.record(TERMINAL, [sid(1), sid(2)])
    const before = readFileSync(path.join(dir, `${TERMINAL}.json`), 'utf8')
    const again = spill.record(TERMINAL, [sid(1), sid(2)])
    expect(again.ok).toBe(true)
    expect(again.appended).toEqual([])
    expect(readFileSync(path.join(dir, `${TERMINAL}.json`), 'utf8')).toBe(before)
  })

  it('withSessionLineage never records the same id twice', () => {
    const node = { claudeSessionId: sid(2), sessionLineage: [sid(1), sid(2)] }
    // A rebind back to an id already on the chain (a fork that returns, a
    // re-resolve) must not grow the array with a duplicate.
    const patch = withSessionLineage(node, sid(3))
    expect(patch.sessionLineage).toEqual([sid(1), sid(2)])
  })
})

describe('L4 — migration seeds the spill from what the node already has', () => {
  it('a node at the old cap gains a spill of its 20 ids on first read', () => {
    const dir = freshDir()
    const spill = new LineageSpill(dir)
    const atCap = Array.from({ length: 20 }, (_, i) => sid(i))
    const node = { claudeSessionId: sid(20), sessionLineage: atCap }

    expect(existsSync(path.join(dir, `${TERMINAL}.json`))).toBe(false)
    const reachable = spill.reachable(TERMINAL, node)
    expect(reachable).toHaveLength(21)
    expect(spill.idsOf(TERMINAL)).toEqual([...atCap, sid(20)])
  })

  it('migration never rewrites destructively — an existing spill only grows', () => {
    const dir = freshDir()
    const spill = new LineageSpill(dir)
    spill.record(TERMINAL, [sid(90), sid(91)]) // ids the node no longer carries
    const node = { claudeSessionId: sid(20), sessionLineage: [sid(19)] }

    expect(spill.reachable(TERMINAL, node)).toEqual([sid(90), sid(91), sid(19), sid(20)])
    expect(spill.idsOf(TERMINAL)).toEqual([sid(90), sid(91), sid(19), sid(20)])
  })
})
