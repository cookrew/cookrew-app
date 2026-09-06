import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The sweep walks teams/ while TeamStore may be writing there: a save clones
 * a session into a sidecar dir and then commits the JSON that names it
 * (teams.ts snapshotSessions → writeFileSync), and a prune rm -rf's a sidecar
 * dir whose map emptied. Each race is staged through a mocked fs primitive at
 * the exact call the real sweep makes, so the ORDER of the sweep's passes is
 * what these tests pin.
 */

/** What the mock does at a given call — set per test, read by the mock. */
const stage: {
  onReaddir?: (dir: string) => void
  readdirThrows?: (dir: string) => boolean
} = {}

const enoent = (): NodeJS.ErrnoException => {
  const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('vanished.jsonl')) throw enoent()
      return (actual.statSync as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof actual.statSync,
    readdirSync: ((dir: string, ...rest: unknown[]) => {
      if (stage.readdirThrows?.(String(dir))) throw enoent()
      const listed = (actual.readdirSync as (...args: unknown[]) => unknown)(dir, ...rest)
      stage.onReaddir?.(String(dir))
      return listed
    }) as typeof actual.readdirSync
  }
})

const { defaultStorageRoots, sweepStorage } = await import('../src/main/storage-gc-scan')

const DAY = 24 * 60 * 60 * 1000
const old = new Date(Date.now() - 90 * DAY)

function store(): ReturnType<typeof defaultStorageRoots> {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-gc-race-'))
  const roots = defaultStorageRoots(base)
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(roots.workspaces, 'workspace.json'), JSON.stringify({ nodes: [] }))
  return roots
}

function aged(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{}')
  utimesSync(file, old, old)
}

beforeEach(() => {
  stage.onReaddir = undefined
  stage.readdirThrows = undefined
})

describe('sweepStorage — races with a concurrent TeamStore', () => {
  it('a candidate that vanishes between walk and stat is dropped, the rest of the sweep survives', () => {
    const roots = store()
    aged(path.join(roots.teams, 'lost-sessions', 'vanished.jsonl'))
    aged(path.join(roots.teams, 'lost-sessions', 'stays.jsonl'))
    aged(path.join(roots.turns, 'dead.jsonl'))

    const out = sweepStorage({ roots })

    expect(out.remove.map((c) => c.key).sort()).toEqual(['dead', path.join('lost-sessions', 'stays.jsonl')])
  })

  it('a team save landing between the candidate pass and the reference pass keeps the now-named sidecar', () => {
    // An OLD sidecar file with no team yet (a save that once failed after the
    // clone). The save lands the moment the sweep has listed the sidecar dir:
    // the JSON that names a.jsonl appears before references are read. With
    // candidates listed first the file is referenced → kept. Read references
    // first and the same file is an orphan that a later pass then lists.
    const roots = store()
    aged(path.join(roots.teams, 'crew-sessions', 'a.jsonl'))
    let landed = false
    stage.onReaddir = (dir) => {
      if (landed || path.basename(dir) !== 'crew-sessions') return
      landed = true
      writeFileSync(
        path.join(roots.teams, 'crew.json'),
        JSON.stringify({ name: 'Crew', nodes: [], sessions: { t1: 'a.jsonl' } })
      )
    }

    const out = sweepStorage({ roots })

    expect(landed).toBe(true)
    expect(out.remove).toEqual([])
    expect(out.kept.live).toBe(1)
  })

  it('a sidecar dir pruned between existsSync and readdir costs that dir, not the sweep', () => {
    const roots = store()
    aged(path.join(roots.teams, 'gone-sessions', 'x.jsonl'))
    aged(path.join(roots.teams, 'lost-sessions', 'y.jsonl'))
    aged(path.join(roots.turns, 'dead.jsonl'))
    stage.readdirThrows = (dir) => path.basename(dir) === 'gone-sessions'

    const out = sweepStorage({ roots })

    expect(out.skipped).toEqual([])
    expect(out.remove.map((c) => c.key).sort()).toEqual(['dead', path.join('lost-sessions', 'y.jsonl')])
  })

  it('a teams dir that cannot be listed at all aborts every class', () => {
    const roots = store()
    aged(path.join(roots.turns, 'dead.jsonl'))
    stage.readdirThrows = (dir) => dir === roots.teams

    const out = sweepStorage({ roots })

    expect(out.skipped).toEqual(['ledgers', 'attachments', 'sidecars', 'served'])
    expect(out.remove).toEqual([])
  })
})
