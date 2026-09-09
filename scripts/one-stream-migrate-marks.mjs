#!/usr/bin/env node
// THE MARK MIGRATION — phase T4 of "One stream"
// (docs/site/one-stream-2026-09-07.html, "The migration, and why nothing is
// lost").
//
//   node scripts/one-stream-migrate-marks.mjs              # DRY RUN (default)
//   node scripts/one-stream-migrate-marks.mjs --write      # performs it
//   node scripts/one-stream-migrate-marks.mjs --write --marks-dir /tmp/marks
//
// DRY RUN IS THE DEFAULT AND STAYS THE DEFAULT. T1's rehearsal made the flag
// mandatory so nobody could run it by accident; the same instinct applies to
// the real thing, in the other direction — a bare invocation must print, not
// write. `--write` is the only thing that appends a byte.
//
// WHAT IT DOES, per ~/.cookrew/turns/<terminal>.jsonl:
//   · reads the old store through TurnStore's own reader (annotation sidecar
//     hydrated), so nothing here re-implements the read the app performs;
//   · plans one mark per checkpoint identity — mark-migration.ts owns the
//     placement rules and every test of them (tests/mark-migration.test.ts);
//   · writes each patch through marks.ts's writeMark, never a hand-rolled
//     append, so the ledger's own refusals (conversation text, a key outside
//     the mark's five, an unusable terminal id) apply to the migration too;
//   · re-reads the marks back THROUGH the stream (stream-marks.checkpoints)
//     and names every identity that resolves to no row.
//
// IT IS IDEMPOTENT. Every patch is diffed against the ledger already on disk,
// so a second `--write` appends nothing. That is what makes this safe to
// re-run after fixing an unplaceable pin by hand.
//
// IT COPIES THE LEDGERS BEFORE READING THEM, for the same reason the
// equivalence harness does: TurnStore.load() could schedule a fold, and a
// migration must not rewrite the thing it is migrating FROM. The copy is the
// read side only — marks are written to the real ~/.cookrew/marks (or
// --marks-dir).
//
// PRINTS NO CONVERSATION TEXT. Identities (truncated), indices, field names
// and counts. Never a prompt, a reply or a title body.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')

if (process.env.ONE_STREAM_INNER !== '1') {
  const result = spawnSync(
    'npx',
    ['--no-install', 'vite-node', SELF, '--', ...process.argv.slice(2)],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ONE_STREAM_INNER: '1',
        // One measured chain is 119 + 91 + 91 + 71 MB; the verification pass
        // walks one card's chain at a time but must be able to hold it.
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim()
      }
    }
  )
  process.exit(result.status ?? 1)
}

const { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = await import(
  'node:fs'
)
const { homedir, tmpdir } = await import('node:os')

const { TurnStore } = await import('../src/main/turn-store.ts')
const { TraceReader } = await import('../src/main/trace.ts')
const { createStreamReader } = await import('../src/main/stream.ts')
const { createStreamIndexStore } = await import('../src/main/stream-materialise.ts')
const { emptyStreamState } = await import('../src/main/stream-state.ts')
const { claudeStreamChain, nodeLineageIds } = await import('../src/main/stream-chain.ts')
const { LineageSpill, defaultSpillDir } = await import('../src/main/lineage-spill.ts')
const { harnessFor } = await import('../src/main/harness.ts')
const { isClaudeCommand } = await import('../src/shared/claude-fork.ts')
const { unionLineage } = await import('../src/shared/lineage-spill-format.mjs')
const { applyPlan, planCard, verifyPlan } = await import('../src/main/mark-migration.ts')

const HOME = homedir()
const COOKREW = path.join(HOME, '.cookrew')
const TURNS = path.join(COOKREW, 'turns')
const ANNOTATIONS = path.join(COOKREW, 'checkpoint-annotations')
const WORKSPACES = path.join(COOKREW, 'workspaces')
const PINS = path.join(COOKREW, 'pins')

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const write = args.includes('--write')
const onlyCard = flag('--card')
const limit = Number(flag('--limit') ?? 0)
const marksDir = flag('--marks-dir')
const markOptions = marksDir === undefined ? {} : { dir: marksDir }

const short = (id) => (typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id ?? ''))
const out = (text) => process.stdout.write(text)

/** Every terminal node the workspaces hold, by id. Read-only. */
function terminalNodes() {
  const nodes = new Map()
  let workspaceIds = []
  try {
    workspaceIds = readdirSync(WORKSPACES)
  } catch {
    return nodes
  }
  for (const id of workspaceIds) {
    const file = path.join(WORKSPACES, id, 'workspace.json')
    if (!existsSync(file)) continue
    try {
      const workspace = JSON.parse(readFileSync(file, 'utf8'))
      for (const node of workspace.nodes ?? []) {
        if (typeof node.id === 'string') nodes.set(node.id, node)
      }
    } catch {
      // A workspace that will not parse costs its cards, not the run.
    }
  }
  return nodes
}

/** Fork references grouped by the SOURCE card they point back at. */
function forkReferences(nodes) {
  const bySource = new Map()
  for (const node of nodes.values()) {
    const origin = node.forkOf
    if (!origin || typeof origin.sourceId !== 'string') continue
    if (typeof origin.turnIndex !== 'number') continue
    bySource.set(origin.sourceId, [
      ...(bySource.get(origin.sourceId) ?? []),
      { child: node.id, turnIndex: origin.turnIndex }
    ])
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

/** node lineage ∪ spill, oldest first, WITHOUT the migration write. */
function readOnlyLineage(spill) {
  return (node) => unionLineage(spill.idsOf(node.id), nodeLineageIds(node))
}

/** The files that ARE this card's stream — the equivalence harness's rule. */
async function chainFor(node, lineageIds) {
  if (isClaudeCommand(node.command) && node.claudeSessionId) {
    return claudeStreamChain(node, { lineageIds })
  }
  const harness = harnessFor(node.command ?? '')
  if (!harness?.watchFile || harness.turns !== 'file') return { files: [], missing: [] }
  let file = null
  try {
    file = harness.watchFile(node, {})
  } catch {
    file = null
  }
  if (!file || !existsSync(file)) return { files: [], missing: [] }
  return { files: [{ sessionId: harness.id, file, kind: harness.id }], missing: [] }
}

/**
 * The stream's rail for one card, materialised with its state HELD IN MEMORY.
 *
 * Writing ~/.cookrew/stream/<id>.json here would be the migration modifying
 * something it is only supposed to read — the same rule that makes it copy the
 * turns ledgers. A fresh reader per card, because the byte cache pins a polled
 * file for 15s and 279 chains at once would pin every one of them.
 */
function checkpointReader(nodes, lineageIds) {
  return async (terminalId) => {
    const node = nodes.get(terminalId)
    if (node === undefined) {
      return {
        checkpoints: [],
        note: 'no card in any workspace owns this ledger any more (the node was deleted)'
      }
    }
    const chain = await chainFor(node, lineageIds)
    if (chain.files.length === 0) {
      return { checkpoints: [], note: "this card's chain resolves to no transcript on disk" }
    }
    const trace = new TraceReader({ nodeAcrossWorkspaces: () => null })
    const stream = createStreamReader({
      chainOf: async () => chain,
      documentOf: (file, kind) => trace.documentOf(file, kind)
    })
    let held = emptyStreamState()
    const materialised = createStreamIndexStore({
      lines: (id) => stream.lines(id),
      readState: () => held,
      writeState: (_id, next) => {
        held = next
        return { ok: true }
      },
      log: () => {}
    })
    const { entries } = await materialised.materialise(terminalId)
    return { checkpoints: entries.map((entry) => ({ identity: entry.identity })) }
  }
}

function emptyTotals() {
  return {
    cards: 0,
    cardsWithMarks: 0,
    marks: 0,
    titles: 0,
    seenAt: 0,
    anchors: 0,
    pins: 0,
    forks: 0,
    derivedIdentities: 0,
    records: 0,
    written: 0,
    unchanged: 0
  }
}

function addCounts(totals, plan, records) {
  totals.cards += 1
  totals.records += records
  for (const key of ['marks', 'titles', 'seenAt', 'anchors', 'pins', 'forks', 'derivedIdentities']) {
    totals[key] += plan.counts[key]
  }
  if (plan.counts.marks > 0) totals.cardsWithMarks += 1
}

function printCard(plan, records) {
  if (plan.counts.marks === 0 && plan.unplaceable.length === 0) return
  out(
    `${short(plan.terminalId)}  marks=${String(plan.counts.marks).padStart(4)} ` +
      `titles=${String(plan.counts.titles).padStart(4)} ` +
      `seenAt=${String(plan.counts.seenAt).padStart(4)} ` +
      `anchors=${String(plan.counts.anchors).padStart(4)} ` +
      `pins=${plan.counts.pins} forks=${plan.counts.forks} ` +
      `derived=${plan.counts.derivedIdentities} over ${records} records\n`
  )
}

async function main() {
  if (!existsSync(TURNS)) {
    out('no ~/.cookrew/turns — nothing to migrate\n')
    return 0
  }
  const sandbox = mkdtempSync(path.join(tmpdir(), 'one-stream-marks-'))
  const turnsCopy = path.join(sandbox, 'turns')
  const annotationsCopy = path.join(sandbox, 'checkpoint-annotations')
  cpSync(TURNS, turnsCopy, { recursive: true })
  if (existsSync(ANNOTATIONS)) cpSync(ANNOTATIONS, annotationsCopy, { recursive: true })

  const store = new TurnStore(turnsCopy, annotationsCopy)
  const nodes = terminalNodes()
  const forks = forkReferences(nodes)
  const spill = new LineageSpill(defaultSpillDir())
  const checkpointsOf = checkpointReader(nodes, readOnlyLineage(spill))

  let ids = readdirSync(turnsCopy)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.replace(/\.jsonl$/, ''))
    .sort()
  if (onlyCard) ids = ids.filter((id) => id === onlyCard || id.startsWith(onlyCard))
  if (limit > 0) ids = ids.slice(0, limit)

  const totals = emptyTotals()
  const unplaceable = []
  const failures = []
  const orphans = []
  const started = Date.now()

  out(
    write
      ? '# one-stream mark migration — WRITING\n'
      : '# one-stream mark migration — DRY RUN, nothing is written (--write performs it)\n'
  )
  out(`# marks ledger: ${marksDir ?? path.join(COOKREW, 'marks')}\n`)
  out('# per card: marks / titles / seenAt / anchors / pins / forks / derived\n\n')

  for (const [at, id] of ids.entries()) {
    const records = store.load(id)
    const plan = planCard({
      terminalId: id,
      records,
      pins: pinsOf(id),
      forks: forks.get(id) ?? []
    })
    addCounts(totals, plan, records.length)
    unplaceable.push(...plan.unplaceable)
    printCard(plan, records.length)

    if (write) {
      const applied = applyPlan(plan, markOptions)
      totals.written += applied.written
      totals.unchanged += applied.unchanged
      failures.push(...applied.failures)
    }
    // The verification runs in BOTH modes: a dry run that could not say which
    // titles would be orphaned would not be worth running.
    orphans.push(...(await verifyPlan(plan, { checkpointsOf })))
    if ((at + 1) % 25 === 0) {
      process.stderr.write(
        `… ${at + 1}/${ids.length} (${Math.round((Date.now() - started) / 1000)}s)\n`
      )
    }
  }

  rmSync(sandbox, { recursive: true, force: true })

  out(write ? '\n# summary (WROTE)\n' : '\n# summary (DRY RUN — no marks written)\n')
  out(`cards: ${totals.cards} (${totals.cardsWithMarks} carry marks) over ${totals.records} old records\n`)
  out(`mark lines planned: ${totals.marks}\n`)
  out(`  titles: ${totals.titles}\n`)
  out(`  seenAt: ${totals.seenAt}\n`)
  out(`  anchors (record scrollLine): ${totals.anchors}\n`)
  out(`  pins: ${totals.pins}\n`)
  out(`  forks: ${totals.forks}\n`)
  out(`records placed by the DERIVED digest (no uuid): ${totals.derivedIdentities}\n`)
  if (write) {
    out(`written: ${totals.written}   already in the ledger (idempotent): ${totals.unchanged}\n`)
  }

  out(`\n# unplaceable: ${unplaceable.length}\n`)
  for (const item of unplaceable) {
    out(`  ${short(item.terminalId)}  ${item.kind} @index ${item.index} — ${item.reason}\n`)
  }

  // Grouped by card and reason: 8,000 identities one per line is a wall, and
  // the question a reader has is "which cards lost titles, and why".
  const byCard = new Map()
  for (const orphan of orphans) {
    const key = `${orphan.terminalId} ${orphan.reason}`
    byCard.set(key, (byCard.get(key) ?? 0) + 1)
  }
  out(
    `\n# orphan marks — planned identities the stream shows on no row: ` +
      `${orphans.length} over ${new Set(orphans.map((o) => o.terminalId)).size} card(s)\n`
  )
  for (const [key, count] of [...byCard].sort((a, b) => b[1] - a[1])) {
    const [terminalId, reason] = key.split(' ')
    out(`  ${short(terminalId)}  ${String(count).padStart(4)} orphan(s) — ${reason}\n`)
  }

  if (failures.length > 0) {
    out(`\n# WRITE FAILURES: ${failures.length}\n`)
    for (const failure of failures) {
      out(`  ${short(failure.terminalId)}  ${short(failure.identity)} — ${failure.error}\n`)
    }
  }
  out(`elapsed: ${Math.round((Date.now() - started) / 1000)}s\n`)
  // An orphan is REPORTED, never a failure: it is evidence a transcript moved,
  // and the mark is still on disk for the day it comes back.
  return failures.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`mark migration failed: ${error?.stack ?? error}\n`)
    process.exit(2)
  }
)
