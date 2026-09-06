import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * The sweep walks teams/*-sessions while TeamStore.pruneSessionSidecars may be
 * unlinking there (a team save during the boot-time sweep). A file that is
 * gone between the walk and its stat is nobody's candidate — and must not
 * take the whole sweep down with it, ledgers and attachments included.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('vanished.jsonl')) {
        const error = new Error('ENOENT: no such file') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return (actual.statSync as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof actual.statSync
  }
})

const { defaultStorageRoots, sweepStorage } = await import('../src/main/storage-gc-scan')

const DAY = 24 * 60 * 60 * 1000

describe('sweepStorage — a candidate that vanishes mid-scan', () => {
  it('is dropped from the plan without losing the rest of the sweep', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-gc-race-'))
    const roots = defaultStorageRoots(base)
    for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(roots.workspaces, 'workspace.json'), JSON.stringify({ nodes: [] }))
    const old = new Date(Date.now() - 90 * DAY)
    const aged = (file: string): void => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '{}')
      utimesSync(file, old, old)
    }
    aged(path.join(roots.teams, 'lost-sessions', 'vanished.jsonl'))
    aged(path.join(roots.teams, 'lost-sessions', 'stays.jsonl'))
    aged(path.join(roots.turns, 'dead.jsonl'))

    const out = sweepStorage({ roots })

    expect(out.remove.map((c) => c.key).sort()).toEqual(['dead', path.join('lost-sessions', 'stays.jsonl')])
  })
})
