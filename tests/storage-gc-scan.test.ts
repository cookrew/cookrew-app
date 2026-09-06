import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectReferencedSidecars,
  defaultStorageRoots,
  sidecarCandidates,
  sweepStorage
} from '../src/main/storage-gc-scan'

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
    expect(out.skipped).toEqual(['ledgers', 'attachments', 'sidecars'])
    expect(existsSync(path.join(roots.turns, 'live-term.jsonl'))).toBe(true)
  })

  it('an empty store sweeps cleanly rather than throwing', () => {
    const roots = store()
    expect(sweepStorage({ roots, apply: true }).bytes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Team session sidecars: teams/<slug>-sessions/<file>, named by the team's
// sessions map. The app resolves them through fileSlug(team.name), so the
// fixtures write the JSON under the slug of the NAME, exactly as TeamStore does.
// ---------------------------------------------------------------------------

interface SidecarFile {
  name: string
  ageDays?: number
}

/** A saved team on disk, its JSON and its sidecar files; JSON omitted when `json` is null. */
function team(
  roots: ReturnType<typeof defaultStorageRoots>,
  slug: string,
  json: { name: string; sessions?: Record<string, string> } | string | null,
  files: SidecarFile[]
): string {
  if (json !== null) {
    const body = typeof json === 'string' ? json : JSON.stringify({ nodes: [], ...json })
    writeFileSync(path.join(roots.teams, `${slug}.json`), body)
  }
  const dir = path.join(roots.teams, `${slug}-sessions`)
  for (const file of files) aged(path.join(dir, file.name), '{"line":1}\n', file.ageDays ?? 90)
  return dir
}

const sidecarKeys = (out: ReturnType<typeof sweepStorage>): string[] =>
  out.remove
    .map((c) => c.key)
    .filter((k) => path.dirname(k).endsWith('-sessions'))
    .sort()

describe('sweepStorage — team session sidecars', () => {
  it('KEEPS a sidecar the owning team names (live-named)', () => {
    const roots = store()
    const dir = team(roots, 'crew', { name: 'Crew', sessions: { t1: 'a.jsonl' } }, [{ name: 'a.jsonl' }])

    const out = sweepStorage({ roots, apply: true })

    expect(sidecarKeys(out)).toEqual([])
    expect(out.kept.live).toBe(1)
    expect(existsSync(path.join(dir, 'a.jsonl'))).toBe(true)
  })

  it('collects a file the live team no longer names and leaves the dir (orphan-in-live-team)', () => {
    const roots = store()
    const dir = team(roots, 'crew', { name: 'Crew', sessions: { t1: 'a.jsonl' } }, [
      { name: 'a.jsonl' },
      { name: 'stale.jsonl' }
    ])

    const out = sweepStorage({ roots, apply: true })

    expect(sidecarKeys(out)).toEqual([path.join('crew-sessions', 'stale.jsonl')])
    expect(readdirSync(dir)).toEqual(['a.jsonl'])
  })

  it('collects every file of a team whose JSON is gone and leaves the empty dir (team-missing)', () => {
    // The directory itself is never removed: snapshotSessions mkdirs the dir
    // and copies into it in two steps, and an rmdir between them would save
    // the team without its sidecar. An empty dir is zero bytes.
    const roots = store()
    team(roots, 'crew', { name: 'Crew', sessions: { t1: 'a.jsonl' } }, [{ name: 'a.jsonl' }])
    const lost = team(roots, 'lost', null, [{ name: 'x.jsonl' }, { name: 'y.jsonl' }])

    const out = sweepStorage({ roots, apply: true })

    expect(sidecarKeys(out)).toEqual([path.join('lost-sessions', 'x.jsonl'), path.join('lost-sessions', 'y.jsonl')])
    expect(readdirSync(lost)).toEqual([])
    expect(existsSync(path.join(roots.teams, 'crew-sessions', 'a.jsonl'))).toBe(true)
  })

  it('resolves the sidecar through the slug of the team NAME, as the app does', () => {
    // The JSON stem and the name slug agree on every live team, but the app
    // never reads the stem: sessionLines opens <fileSlug(name)>-sessions/.
    const roots = store()
    writeFileSync(
      path.join(roots.teams, 'renamed-by-hand.json'),
      JSON.stringify({ name: 'COOKREW CORE', nodes: [], sessions: { t1: 'a.jsonl' } })
    )
    aged(path.join(roots.teams, 'cookrew-core-sessions', 'a.jsonl'), '{}')

    expect(collectReferencedSidecars(roots)).toEqual(new Set([path.join('cookrew-core-sessions', 'a.jsonl')]))
    expect(sidecarKeys(sweepStorage({ roots }))).toEqual([])
  })

  it('a file name named only by ANOTHER team is not live — that team reads its own dir', () => {
    const roots = store()
    team(roots, 'cookrew-team', { name: 'COOKREW TEAM', sessions: { t1: '1faa.jsonl' } }, [{ name: '1faa.jsonl' }])
    team(roots, 'cookrew-core', { name: 'COOKREW CORE', sessions: {} }, [{ name: '1faa.jsonl' }])

    const out = sweepStorage({ roots, apply: true })

    expect(sidecarKeys(out)).toEqual([path.join('cookrew-core-sessions', '1faa.jsonl')])
    expect(existsSync(path.join(roots.teams, 'cookrew-team-sessions', '1faa.jsonl'))).toBe(true)
  })

  it('REFUSES to plan ANY class when one team JSON is unreadable (unreadable-team-aborts)', () => {
    // A half-written team could name every sidecar file — and every terminal
    // id and attachment too. One store we cannot read aborts the whole sweep,
    // and `skipped` names all three classes so the boot log can say why.
    const roots = store()
    team(roots, 'lost', null, [{ name: 'x.jsonl' }])
    team(roots, 'broken', '{"name": "Broken", "sessions": {', [{ name: 'b.jsonl' }])
    aged(path.join(roots.turns, 'dead-term.jsonl'), '{}')
    aged(path.join(roots.attachments, 'orphan.png'), 'binary')

    const out = sweepStorage({ roots, apply: true })

    expect(collectReferencedSidecars(roots)).toBeNull()
    expect(out.skipped).toEqual(['ledgers', 'attachments', 'sidecars'])
    expect(out.remove).toEqual([])
    expect(existsSync(path.join(roots.turns, 'dead-term.jsonl'))).toBe(true)
    expect(existsSync(path.join(roots.attachments, 'orphan.png'))).toBe(true)
    expect(existsSync(path.join(roots.teams, 'lost-sessions', 'x.jsonl'))).toBe(true)
    expect(existsSync(path.join(roots.teams, 'broken-sessions', 'b.jsonl'))).toBe(true)
  })

  it('a parseable file that is not a team names nothing and does NOT abort', () => {
    // TeamStore.read rejects a snapshot without a string name, so such a
    // file can never resolve a sidecar. Aborting on it would let one stray
    // manifest in teams/ switch the class off forever, silently.
    const roots = store()
    team(roots, 'lost', null, [{ name: 'x.jsonl' }])
    team(roots, 'manifest', '{"nodes": []}', [])
    team(roots, 'scalar', '42', [])

    expect(collectReferencedSidecars(roots)).toEqual(new Set())
    const out = sweepStorage({ roots, apply: true })
    expect(out.skipped).toEqual([])
    expect(sidecarKeys(out)).toEqual([path.join('lost-sessions', 'x.jsonl')])
  })

  it('reads a team JSON that is a SYMLINK, as TeamStore does, so its sidecars stay live', () => {
    // readdir does not follow links; readFile does. The app loads a linked
    // team and forks from it — skipping it here would plan its live files.
    const roots = store()
    const elsewhere = path.join(roots.teams, '..', 'synced-crew.json')
    writeFileSync(elsewhere, JSON.stringify({ name: 'Crew', nodes: [], sessions: { t1: 'a.jsonl' } }))
    symlinkSync(elsewhere, path.join(roots.teams, 'crew.json'))
    aged(path.join(roots.teams, 'crew-sessions', 'a.jsonl'), '{}')

    const out = sweepStorage({ roots, apply: true })

    expect(collectReferencedSidecars(roots)).toEqual(new Set([path.join('crew-sessions', 'a.jsonl')]))
    expect(sidecarKeys(out)).toEqual([])
    expect(existsSync(path.join(roots.teams, 'crew-sessions', 'a.jsonl'))).toBe(true)
  })

  it('a DANGLING symlink is an unreadable team: abort', () => {
    const roots = store()
    team(roots, 'lost', null, [{ name: 'x.jsonl' }])
    symlinkSync(path.join(roots.teams, 'does-not-exist.json'), path.join(roots.teams, 'crew.json'))

    const out = sweepStorage({ roots, apply: true })

    expect(out.skipped).toEqual(['ledgers', 'attachments', 'sidecars'])
    expect(existsSync(path.join(roots.teams, 'lost-sessions', 'x.jsonl'))).toBe(true)
  })

  it('a directory named *.json is not a team and not an abort — the app cannot read it either', () => {
    const roots = store()
    team(roots, 'lost', null, [{ name: 'x.jsonl' }])
    mkdirSync(path.join(roots.teams, 'folder.json'))

    const out = sweepStorage({ roots, apply: true })

    expect(out.skipped).toEqual([])
    expect(sidecarKeys(out)).toEqual([path.join('lost-sessions', 'x.jsonl')])
  })

  it('a normal sweep reports no skipped class', () => {
    const roots = store()
    team(roots, 'lost', null, [{ name: 'x.jsonl' }])
    expect(sweepStorage({ roots }).skipped).toEqual([])
  })

  it('a sidecar that cannot be unlinked is reported failed', () => {
    const roots = store()
    const lost = team(roots, 'lost', null, [{ name: 'x.jsonl' }])
    chmodSync(lost, 0o500)
    try {
      const out = sweepStorage({ roots, apply: true })
      expect(out.failed).toEqual([path.join(lost, 'x.jsonl')])
      expect(existsSync(lost)).toBe(true)
    } finally {
      chmodSync(lost, 0o700)
    }
  })

  it('spares an orphan sidecar inside the grace period (grace-period-holds)', () => {
    const roots = store()
    const lost = team(roots, 'lost', null, [{ name: 'x.jsonl', ageDays: 1 }])

    const out = sweepStorage({ roots, apply: true })

    expect(sidecarKeys(out)).toEqual([])
    expect(out.kept.withinGrace).toBe(1)
    expect(existsSync(path.join(lost, 'x.jsonl'))).toBe(true)
  })

  it('a dry run plans the orphan and deletes nothing', () => {
    const roots = store()
    const lost = team(roots, 'lost', null, [{ name: 'x.jsonl' }])

    const dry = sweepStorage({ roots })

    expect(dry.applied).toBe(false)
    expect(sidecarKeys(dry)).toEqual([path.join('lost-sessions', 'x.jsonl')])
    expect(existsSync(path.join(lost, 'x.jsonl'))).toBe(true)
  })

  it('a missing teams dir has no sidecars and plans none', () => {
    const roots = store()
    const blind = { ...roots, teams: path.join(roots.teams, 'nope') }
    expect(sidecarCandidates(blind)).toEqual([])
    expect(collectReferencedSidecars(blind)).toEqual(new Set())
    expect(sweepStorage({ roots: blind, apply: true }).remove).toEqual([])
  })
})
