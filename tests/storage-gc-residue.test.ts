import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isResidueName, scanResidue } from '../src/main/storage-gc-residue'
import { bucketOf } from '../scripts/perf-eval-lib.mjs'

const DAY = 24 * 60 * 60 * 1000
const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function base(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-residue-'))
  made.push(dir)
  return dir
}

function fill(root: string, rel: string, body: string, ageDays = 30): void {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(file, when, when)
}

/** Every residue name found on the owner's machine on 2026-09-06. */
const LIVE_NAMES = [
  'certs.bak-20260807-112810',
  'checkpoint-annotations.bak-20260823-103208',
  'checkpoint-annotations.bak-20260823-105807',
  'turns.bak-20260807-011637',
  'lineage-postwrite-snapshot-222633',
  'lineage-restore-backup-20260823-222123'
]

describe('isResidueName — the same line perf-eval draws', () => {
  it('names every residue directory the live machine has', () => {
    for (const name of LIVE_NAMES) expect(isResidueName(name), name).toBe(true)
  })

  it('leaves the stores themselves, and the app-made backup dirs, alone', () => {
    for (const name of ['turns', 'checkpoint-annotations', 'certs', 'backups', 'session-backups', 'sessions', 'events.1.jsonl', 'bak-notes'])
      expect(isResidueName(name), name).toBe(false)
  })

  it('agrees with perf-eval-lib bucketOf on every name, both ways', () => {
    for (const name of [...LIVE_NAMES, 'turns', 'backups', 'session-backups', 'x.bak-1', 'lineage-x'])
      expect(bucketOf(name) === 'backups', name).toBe(isResidueName(name))
  })
})

describe('scanResidue — a report with sizes, never a plan', () => {
  it('measures each residue entry, largest first, files as well as directories', () => {
    const root = base()
    fill(root, 'turns.bak-20260807-011637/a.jsonl', 'x'.repeat(300))
    fill(root, 'turns.bak-20260807-011637/b.jsonl', 'x'.repeat(200))
    fill(root, 'lineage-restore-backup-20260823-222123/workspaces/w/workspace.json', '{}')
    fill(root, 'pairing-token.bak-1', 'tok')
    fill(root, 'turns/live.jsonl', 'kept')
    const out = scanResidue(root)
    expect(out.map((e) => [path.basename(e.path), e.bytes, e.files])).toEqual([
      ['turns.bak-20260807-011637', 500, 2],
      ['pairing-token.bak-1', 3, 1],
      ['lineage-restore-backup-20260823-222123', 2, 1]
    ])
    // A directory's own mtime counts (it was just created here); a lone file's is its own.
    expect(Date.now() - out[1].newestMtimeMs).toBeGreaterThan(29 * DAY)
  })

  it('finds residue inside the stores too — the live machine has turns/<id>.jsonl.bak-*', () => {
    const root = base()
    fill(root, 'turns/0bd65d5f.jsonl.bak-20260823-105126', 'x'.repeat(40))
    fill(root, 'workspaces/712d/workspace.json.bak-1784623825914', '{}')
    fill(root, 'turns/0bd65d5f.jsonl', 'live')
    expect(scanResidue(root).map((e) => [path.relative(root, e.path), e.files])).toEqual([
      ['turns/0bd65d5f.jsonl.bak-20260823-105126', 1],
      ['workspaces/712d/workspace.json.bak-1784623825914', 1]
    ])
  })

  it('measures a residue entry whole and does not look inside it, nor into sessions/, nor through a link', () => {
    const root = base()
    fill(root, 'lineage-restore-backup-1/turns/x.jsonl.bak-2', 'inner')
    fill(root, 'sessions/svc-a/ana-1/notes.bak-1', 'a caller made this')
    fill(root, 'elsewhere/big', 'x'.repeat(1000))
    symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'certs.bak-link'))
    expect(scanResidue(root).map((e) => path.basename(e.path))).toEqual(['lineage-restore-backup-1'])
  })

  it('a missing base is an empty report, not a throw', () => {
    expect(scanResidue(path.join(base(), 'nope'))).toEqual([])
  })
})
