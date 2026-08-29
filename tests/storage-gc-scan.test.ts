import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultStorageRoots, sweepStorage } from '../src/main/storage-gc-scan'

const DAY = 24 * 60 * 60 * 1000
const made: string[] = []

afterEach(() => {
  made.length = 0
})

/** A store on disk: one live card, one dead card, and some attachments. */
function store(): ReturnType<typeof defaultStorageRoots> {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-gc-'))
  made.push(base)
  const roots = defaultStorageRoots(base)
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })

  mkdirSync(path.join(roots.workspaces, 'w1'), { recursive: true })
  writeFileSync(
    path.join(roots.workspaces, 'w1', 'workspace.json'),
    JSON.stringify({ nodes: [{ id: 'live-term', kind: 'terminal' }] })
  )
  return roots
}

/** Write a file and backdate it past any grace period. */
function aged(file: string, body: string, ageDays = 90): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(file, when, when)
}

describe('sweepStorage — reads the stores, plans, and only then unlinks', () => {
  it('collects a dead ledger and leaves the live one alone', () => {
    const roots = store()
    aged(path.join(roots.turns, 'live-term.jsonl'), '{}')
    aged(path.join(roots.turns, 'dead-term.jsonl'), '{}')

    const out = sweepStorage({ roots, apply: true })

    expect(out.remove.map((c) => c.key)).toEqual(['dead-term'])
    expect(existsSync(path.join(roots.turns, 'live-term.jsonl'))).toBe(true)
    expect(existsSync(path.join(roots.turns, 'dead-term.jsonl'))).toBe(false)
  })

  it('treats a saved team as a live reference, not a dead one', () => {
    // Forking from a template must keep working, so a node id that survives
    // only inside teams/ is as live as one on a canvas.
    const roots = store()
    writeFileSync(
      path.join(roots.teams, 'saved.json'),
      JSON.stringify({ nodes: [{ id: 'in-template', kind: 'terminal' }] })
    )
    aged(path.join(roots.turns, 'in-template.jsonl'), '{}')

    expect(sweepStorage({ roots, apply: true }).remove).toEqual([])
    expect(existsSync(path.join(roots.turns, 'in-template.jsonl'))).toBe(true)
  })

  it('keeps an attachment a note still cites, collects one nothing cites', () => {
    const roots = store()
    aged(path.join(roots.attachments, 'kept.png'), 'binary')
    aged(path.join(roots.attachments, 'orphan.png'), 'binary')
    aged(path.join(roots.workspaces, 'w1', 'notes', 'n1.md'), 'see kept.png')

    const out = sweepStorage({ roots, apply: true })

    expect(out.remove.map((c) => c.key)).toEqual(['orphan.png'])
    expect(existsSync(path.join(roots.attachments, 'kept.png'))).toBe(true)
  })

  it('a dry run reports the same plan and deletes nothing', () => {
    const roots = store()
    aged(path.join(roots.turns, 'dead-term.jsonl'), '{}')

    const dry = sweepStorage({ roots })

    expect(dry.applied).toBe(false)
    expect(dry.remove.map((c) => c.key)).toEqual(['dead-term'])
    expect(existsSync(path.join(roots.turns, 'dead-term.jsonl'))).toBe(true)
  })

  it('spares everything inside the grace period', () => {
    const roots = store()
    aged(path.join(roots.turns, 'dead-term.jsonl'), '{}', 1)

    const out = sweepStorage({ roots, apply: true })

    expect(out.remove).toEqual([])
    expect(out.kept.withinGrace).toBe(1)
  })

  it('REFUSES to collect when the workspace store is missing', () => {
    // The dangerous case: no canvas store reads as "every terminal is dead".
    const roots = store()
    aged(path.join(roots.turns, 'live-term.jsonl'), '{}')
    const blind = { ...roots, workspaces: path.join(roots.workspaces, 'does-not-exist') }

    const out = sweepStorage({ roots: blind, apply: true })

    expect(out.remove).toEqual([])
    expect(existsSync(path.join(roots.turns, 'live-term.jsonl'))).toBe(true)
  })

  it('an empty store sweeps cleanly rather than throwing', () => {
    const roots = store()
    expect(sweepStorage({ roots, apply: true }).bytes).toBe(0)
  })
})
