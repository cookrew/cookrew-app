#!/usr/bin/env node
// THE EQUIVALENCE HARNESS — the gate on phase T1 of "One stream"
// (docs/site/one-stream-2026-09-07.html).
//
//   node scripts/one-stream-equivalence.mjs [--card <id>] [--limit <n>]
//
// For every terminal that has a ~/.cookrew/turns/<id>.jsonl, it compares the
// OLD store's TurnRecord list — read with turn-store's own reader, so the
// comparison cannot be accused of using a friendlier parser — against the
// checkpoint list the stream produces. Same count, same identities in order,
// same titles. Exit 0 only when every card is OK or every difference falls in
// an allow-listed class (src/shared/stream-equivalence.ts documents all six).
//
// WHY IT COPIES THE LEDGERS FIRST. TurnStore.load() can SCHEDULE A FOLD — a
// full atomic rewrite of the ledger it just read. That is correct inside the
// app and unacceptable in a measuring tool: a gate must not modify the thing
// it is measuring. So the turns directory and its annotation sidecar are
// copied to a temp dir and the store is pointed at the copy. Everything else
// this script touches (~/.claude/projects, the spill, the workspaces) is
// opened read-only, and the lineage is read through nodeLineageIds + the
// spill's idsOf rather than reachableLineage(), because reachableLineage
// WRITES the migration it performs.
//
// PRINTS NO CONVERSATION TEXT. Identities (truncated), ordinals, field names
// and counts only — never a prompt, a reply or a title body.
//
// It runs through vite-node so it loads the app's own TypeScript rather than
// a second copy of the logic; the outer pass below re-executes it there.

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
        // A single chain has measured 119 + 91 + 91 + 71 MB. The reader never
        // re-reads, but it does hold one chain's parsed lines at a time.
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
const { claudeStreamChain, nodeLineageIds } = await import('../src/main/stream-chain.ts')
const { LineageSpill, defaultSpillDir } = await import('../src/main/lineage-spill.ts')
const { readMarks } = await import('../src/main/marks.ts')
const { harnessFor } = await import('../src/main/harness.ts')
const { isClaudeCommand } = await import('../src/shared/claude-fork.ts')
const { unionLineage } = await import('../src/shared/lineage-spill-format.mjs')
const { compareCheckpoints, oldCheckpointOf } = await import(
  '../src/shared/stream-equivalence.ts'
)

const HOME = homedir()
const COOKREW = path.join(HOME, '.cookrew')
const TURNS = path.join(COOKREW, 'turns')
const ANNOTATIONS = path.join(COOKREW, 'checkpoint-annotations')
const WORKSPACES = path.join(COOKREW, 'workspaces')

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const onlyCard = flag('--card')
const limit = Number(flag('--limit') ?? 0)

const short = (id) => (typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id ?? ''))

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
        if (node.kind === 'terminal' && typeof node.id === 'string') nodes.set(node.id, node)
      }
    } catch {
      // A workspace that will not parse costs its cards, not the run.
    }
  }
  return nodes
}

/** node lineage u spill, oldest first, WITHOUT the migration write. */
function readOnlyLineage(spill) {
  return (node) => unionLineage(spill.idsOf(node.id), nodeLineageIds(node))
}

/** The files that ARE this card's stream. Non-Claude harnesses have no
 *  lineage to walk — one rollout, one stream — and the harness registry
 *  itself resolves the file, so nothing here is per-harness knowledge. */
async function chainFor(node, lineageIds) {
  if (isClaudeCommand(node.command) && node.claudeSessionId) {
    return claudeStreamChain(node, { lineageIds })
  }
  const harness = harnessFor(node.command)
  if (!harness?.watchFile || harness.turns !== 'file') return { files: [], missing: [] }
  let file = null
  try {
    file = harness.watchFile(node, {})
  } catch {
    file = null
  }
  if (!file) return { files: [], missing: [] }
  if (!existsSync(file)) {
    return { files: [], missing: [{ sessionId: harness.id, file, reason: 'no-transcript' }] }
  }
  return { files: [{ sessionId: harness.id, file, kind: harness.id }], missing: [] }
}

async function main() {
  if (!existsSync(TURNS)) {
    process.stdout.write('no ~/.cookrew/turns — nothing to compare\n')
    return 0
  }
  // The gate must not modify what it measures: see the header.
  const sandbox = mkdtempSync(path.join(tmpdir(), 'one-stream-equiv-'))
  const turnsCopy = path.join(sandbox, 'turns')
  const annotationsCopy = path.join(sandbox, 'checkpoint-annotations')
  cpSync(TURNS, turnsCopy, { recursive: true })
  if (existsSync(ANNOTATIONS)) cpSync(ANNOTATIONS, annotationsCopy, { recursive: true })

  const store = new TurnStore(turnsCopy, annotationsCopy)
  const nodes = terminalNodes()
  const spill = new LineageSpill(defaultSpillDir())
  const lineageIds = readOnlyLineage(spill)

  let ids = readdirSync(turnsCopy)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.replace(/\.jsonl$/, ''))
    .sort()
  if (onlyCard) ids = ids.filter((id) => id === onlyCard || id.startsWith(onlyCard))
  if (limit > 0) ids = ids.slice(0, limit)

  const totals = { ok: 0, allowed: 0, failed: 0, oldRecords: 0, streamBlocks: 0, withStream: 0 }
  const classCounts = {}
  const failures = []
  const started = Date.now()

  process.stdout.write(`# one-stream equivalence — ${ids.length} card(s)\n`)
  process.stdout.write('# identities and ordinals only; no prompt, reply or title text\n\n')

  for (const [at, id] of ids.entries()) {
    const records = store.load(id)
    const node = nodes.get(id)
    const chain = node ? await chainFor(node, lineageIds) : { files: [], missing: [] }
    // A FRESH reader per card: the byte cache pins a polled file for 15s by
    // design, and a script that walks 279 chains back to back would pin every
    // one of them at once.
    const trace = new TraceReader({ nodeAcrossWorkspaces: () => null })
    const stream = createStreamReader({
      chainOf: async () => chain,
      documentOf: (file, kind) => trace.documentOf(file, kind)
    })
    const { entries, missing } = await stream.index(id)
    const marks = readMarks(id)
    const streamRows = entries.map((entry) => ({
      ordinal: entry.ordinal,
      identity: entry.identity,
      ...(marks.get(entry.identity)?.title !== undefined
        ? { title: marks.get(entry.identity).title }
        : {})
    }))
    const result = compareCheckpoints(records.map(oldCheckpointOf), streamRows, {
      streamAvailable: chain.files.length > 0,
      cardKnown: node !== undefined
    })

    totals.oldRecords += records.length
    totals.streamBlocks += entries.length
    if (chain.files.length > 0) totals.withStream += 1
    for (const [name, count] of Object.entries(result.classCounts)) {
      classCounts[name] = (classCounts[name] ?? 0) + count
    }

    const head =
      `${short(id)}  old=${String(records.length).padStart(4)} ` +
      `stream=${String(entries.length).padStart(4)}` +
      (missing.length > 0 ? `  missing-files=${missing.length}` : '') +
      (node ? '' : '  (no node in any workspace)')
    if (result.ok) {
      totals.ok += 1
      process.stdout.write(`OK    ${head}\n`)
    } else {
      const classes = Object.entries(result.classCounts)
        .map(([name, count]) => `${name}=${count}`)
        .join(' ')
      if (result.allowed) {
        totals.allowed += 1
        process.stdout.write(`OK*   ${head}  ${classes}\n`)
      } else {
        totals.failed += 1
        failures.push(id)
        process.stdout.write(`DIFF  ${head}  ${classes}\n`)
      }
      for (const difference of result.differences.slice(0, 3)) {
        process.stdout.write(
          `        ${difference.class} identity=${short(difference.identity)} ` +
            `ordinal=${difference.ordinal ?? '-'} field=${difference.field} — ${difference.detail}\n`
        )
      }
    }
    if ((at + 1) % 25 === 0) {
      process.stderr.write(`… ${at + 1}/${ids.length} (${Math.round((Date.now() - started) / 1000)}s)\n`)
    }
  }

  rmSync(sandbox, { recursive: true, force: true })

  process.stdout.write('\n# summary\n')
  process.stdout.write(
    `cards: ${ids.length}  identical: ${totals.ok}  ` +
      `allowed-differences: ${totals.allowed}  FAILED: ${totals.failed}\n`
  )
  process.stdout.write(
    `cards with a resolvable stream: ${totals.withStream}\n`
  )
  const delta = totals.streamBlocks - totals.oldRecords
  process.stdout.write(
    `records: old=${totals.oldRecords} stream=${totals.streamBlocks} ` +
      `(${delta >= 0 ? '+' : ''}${delta})\n`
  )
  // The load-bearing claim, stated as a number rather than an absence.
  process.stdout.write(
    `checkpoints the old store holds that the stream cannot reach: ` +
      `${classCounts['identity-missing'] ?? 0}\n`
  )
  for (const [name, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${name}: ${count}\n`)
  }
  if (failures.length > 0) {
    process.stdout.write(`failed cards: ${failures.map(short).join(' ')}\n`)
  }
  process.stdout.write(`elapsed: ${Math.round((Date.now() - started) / 1000)}s\n`)
  return totals.failed === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`equivalence harness failed: ${error?.stack ?? error}\n`)
    process.exit(2)
  }
)
