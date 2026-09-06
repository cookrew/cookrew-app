#!/usr/bin/env node
// THE MARK MIGRATION, REHEARSED — phase T1 of "One stream"
// (docs/site/one-stream-2026-09-07.html).
//
//   node scripts/one-stream-migrate-marks.mjs --dry-run
//
// T1 WRITES NOTHING. The flag is mandatory and there is no other mode: this
// run exists to say, out loud and before anything is switched, exactly how
// many marks the migration would create and how many of them it could not
// place. The design's step 1 is "marks are extracted from the old store
// once" — {identity, title, seenAt} per record, plus pins and fork
// references from where they live now — and its stated risk is that a
// mis-derived identity silently DETACHES an old title. Counting the
// unplaceable ones now is how that risk stops being a surprise later.
//
// WHERE EACH PIECE COMES FROM
//   title, seenAt   ~/.cookrew/turns/<id>.jsonl, hydrated with its annotation
//                   sidecar by turn-store's own reader (the same read path the
//                   app uses, so nothing is invented here).
//   identity        TurnRecord.uuid — which IS checkpointIdentity's output for
//                   file-derived records, the exact key the renderer joins on
//                   today. A record with no uuid CANNOT be placed and is
//                   counted, never guessed: guessing is how a title lands on
//                   the wrong exchange.
//   pin             ~/.cookrew/pins/<id>.json (VersionPinRecord). `atUuid` is
//                   the anchor when present; a legacy pin carries only
//                   `atIndex`, and those are resolved through the old ledger's
//                   own record at that index — reported separately, because an
//                   index-keyed pin on a card that later compacted is exactly
//                   the drift this design removes.
//   fork            a node's `forkOf` {sourceId, turnIndex} — the reference
//                   lives on the CHILD and points back at the source card's
//                   turn, so the mark belongs on the SOURCE at that turn's
//                   identity.
//
// Reads only. The ledgers are copied to a temp dir first because
// TurnStore.load() can schedule a fold, and a rehearsal must not rewrite the
// thing it is rehearsing on. Prints identities and counts, never text.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')

if (process.env.ONE_STREAM_INNER !== '1') {
  const result = spawnSync(
    'npx',
    ['--no-install', 'vite-node', SELF, '--', ...process.argv.slice(2)],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ONE_STREAM_INNER: '1' } }
  )
  process.exit(result.status ?? 1)
}

const { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = await import(
  'node:fs'
)
const { homedir, tmpdir } = await import('node:os')
const { TurnStore } = await import('../src/main/turn-store.ts')
const { MARK_TITLE_MAX } = await import('../src/main/marks.ts')

const HOME = homedir()
const COOKREW = path.join(HOME, '.cookrew')
const TURNS = path.join(COOKREW, 'turns')
const ANNOTATIONS = path.join(COOKREW, 'checkpoint-annotations')
const WORKSPACES = path.join(COOKREW, 'workspaces')
const PINS = path.join(COOKREW, 'pins')

if (!process.argv.includes('--dry-run')) {
  process.stderr.write(
    'refusing to run without --dry-run: T1 writes no marks (see the header)\n'
  )
  process.exit(2)
}

const short = (id) => (typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id ?? ''))

/** Fork references, grouped by the SOURCE card they point back at. */
function forkReferences() {
  const bySource = new Map()
  let workspaceIds = []
  try {
    workspaceIds = readdirSync(WORKSPACES)
  } catch {
    return bySource
  }
  for (const id of workspaceIds) {
    const file = path.join(WORKSPACES, id, 'workspace.json')
    if (!existsSync(file)) continue
    let workspace
    try {
      workspace = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const node of workspace.nodes ?? []) {
      const origin = node.forkOf
      if (!origin || typeof origin.sourceId !== 'string') continue
      const held = bySource.get(origin.sourceId) ?? []
      held.push({ child: node.id, turnIndex: origin.turnIndex })
      bySource.set(origin.sourceId, held)
    }
  }
  return bySource
}

function pinsOf(terminalId) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(PINS, `${terminalId}.json`), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function main() {
  if (!existsSync(TURNS)) {
    process.stdout.write('no ~/.cookrew/turns — nothing to migrate\n')
    return 0
  }
  const sandbox = mkdtempSync(path.join(tmpdir(), 'one-stream-marks-'))
  const turnsCopy = path.join(sandbox, 'turns')
  const annotationsCopy = path.join(sandbox, 'checkpoint-annotations')
  cpSync(TURNS, turnsCopy, { recursive: true })
  if (existsSync(ANNOTATIONS)) cpSync(ANNOTATIONS, annotationsCopy, { recursive: true })

  const store = new TurnStore(turnsCopy, annotationsCopy)
  const forks = forkReferences()
  const ids = readdirSync(turnsCopy)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.replace(/\.jsonl$/, ''))
    .sort()

  const totals = {
    cards: 0,
    cardsWithMarks: 0,
    marks: 0,
    titles: 0,
    seenAt: 0,
    pins: 0,
    pinsByUuid: 0,
    pinsByIndex: 0,
    pinsUnplaceable: 0,
    forks: 0,
    forksUnplaceable: 0,
    recordsWithoutUuid: 0,
    titlesTooLong: 0,
    records: 0
  }

  process.stdout.write('# one-stream mark migration — DRY RUN, nothing is written\n')
  process.stdout.write('# per card: marks / titles / seenAt / pins / forks\n\n')

  for (const id of ids) {
    const records = store.load(id)
    totals.cards += 1
    totals.records += records.length

    /** identity → the fields a mark would carry. */
    const marks = new Map()
    const place = (identity, field) => {
      const held = marks.get(identity) ?? new Set()
      held.add(field)
      marks.set(identity, held)
    }

    let titles = 0
    let seen = 0
    const byIndex = new Map()
    for (const record of records) {
      if (typeof record.uuid !== 'string') {
        if (record.title !== undefined || record.seenAt !== undefined) {
          totals.recordsWithoutUuid += 1
        }
        continue
      }
      byIndex.set(record.index, record.uuid)
      if (typeof record.title === 'string') {
        titles += 1
        place(record.uuid, 'title')
        if (record.title.length > MARK_TITLE_MAX) totals.titlesTooLong += 1
      }
      if (typeof record.seenAt === 'number') {
        seen += 1
        place(record.uuid, 'seenAt')
      }
    }

    let pins = 0
    for (const pin of pinsOf(id)) {
      pins += 1
      if (typeof pin.atUuid === 'string') {
        totals.pinsByUuid += 1
        place(pin.atUuid, 'pin')
        continue
      }
      const resolved = byIndex.get(pin.atIndex)
      if (resolved === undefined) {
        totals.pinsUnplaceable += 1
        continue
      }
      totals.pinsByIndex += 1
      place(resolved, 'pin')
    }

    let forkCount = 0
    for (const reference of forks.get(id) ?? []) {
      forkCount += 1
      const resolved = byIndex.get(reference.turnIndex)
      if (resolved === undefined) {
        totals.forksUnplaceable += 1
        continue
      }
      place(resolved, 'fork')
    }

    totals.titles += titles
    totals.seenAt += seen
    totals.pins += pins
    totals.forks += forkCount
    totals.marks += marks.size
    if (marks.size > 0) {
      totals.cardsWithMarks += 1
      process.stdout.write(
        `${short(id)}  marks=${String(marks.size).padStart(4)} ` +
          `titles=${String(titles).padStart(4)} seenAt=${String(seen).padStart(4)} ` +
          `pins=${pins} forks=${forkCount}\n`
      )
    }
  }

  rmSync(sandbox, { recursive: true, force: true })

  process.stdout.write('\n# summary (DRY RUN — no marks written)\n')
  process.stdout.write(
    `cards: ${totals.cards} (${totals.cardsWithMarks} would get marks) ` +
      `over ${totals.records} old records\n`
  )
  process.stdout.write(`mark lines that would be written: ${totals.marks}\n`)
  process.stdout.write(`  titles: ${totals.titles} (over ${MARK_TITLE_MAX} chars: ${totals.titlesTooLong})\n`)
  process.stdout.write(`  seenAt: ${totals.seenAt}\n`)
  process.stdout.write(
    `  pins: ${totals.pins} (by uuid: ${totals.pinsByUuid}, ` +
      `by legacy index: ${totals.pinsByIndex}, unplaceable: ${totals.pinsUnplaceable})\n`
  )
  process.stdout.write(`  forks: ${totals.forks} (unplaceable: ${totals.forksUnplaceable})\n`)
  process.stdout.write(
    `records with a title/seenAt but NO uuid to place it on: ${totals.recordsWithoutUuid}\n`
  )
  return 0
}

try {
  process.exit(main())
} catch (error) {
  process.stderr.write(`mark migration rehearsal failed: ${error?.stack ?? error}\n`)
  process.exit(2)
}
