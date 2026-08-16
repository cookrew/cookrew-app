// One-off ledger migration for Sol r4 P2 (run with --apply to write).
//
// The abort-only fix in trace-blocks.ts makes parseCodexTurns adopt the
// turn_aborted timestamp as endedAt when NO prior reply/tool activity
// supplied a clock. Historical ledger rows for that exact shape were built
// by the older parser and carry the fabricated zero duration (endedAt ===
// startedAt). The ledger is a derived cache (see ledger-rebuild.ts); this
// migrates ONLY those rows to the new derivation so the corpus round-trip
// gate stays exact:
//
//   patch a stored row iff  stored.endedAt === stored.startedAt
//     AND the rebuilt row at the same index matches on uuid, prompt, reply
//     and startedAt AND differs on endedAt alone.
//
// Untouched lines are preserved byte-for-byte; originals are backed up to
// scratchpad/ledger-backup-<stamp>/ before any write.
//
// Usage:  npx esbuild --bundle scratchpad/migrate-abort-zero-durations.ts \
//           --format=esm --platform=node --outfile=/tmp/migrate-abort.mjs
//         node /tmp/migrate-abort.mjs [--apply]

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseCodexTurns } from '../src/shared/trace-blocks'
import type { TurnRecord } from '../src/shared/turn'

const APPLY = process.argv.includes('--apply')
const TURNS_DIR = path.join(homedir(), '.cookrew', 'turns')
const AGENTS_FILE = path.join(homedir(), '.cookrew', 'agents.json')
const BACKUP_DIR = path.join(
  process.cwd(),
  'scratchpad',
  `ledger-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
)

interface RegistryAgent {
  id: string
  name?: string
  command?: string
  sessionRef?: string | null
}

function registryAgents(): RegistryAgent[] {
  const raw: unknown = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
  const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown[] }).agents
  return Array.isArray(list) ? (list as RegistryAgent[]) : []
}

let patchedRows = 0
let patchedFiles = 0

for (const agent of registryAgents()) {
  if (!(agent.command ?? '').includes('codex')) continue
  const ref = agent.sessionRef ?? undefined
  const ledgerFile = path.join(TURNS_DIR, `${agent.id}.jsonl`)
  if (ref === undefined || !existsSync(ref) || !existsSync(ledgerFile)) continue

  const rebuilt = new Map(
    parseCodexTurns(readFileSync(ref, 'utf8').split('\n')).map((r) => [r.index, r])
  )
  const lines = readFileSync(ledgerFile, 'utf8').split('\n')
  const next = lines.map((line) => {
    if (line.trim().length === 0) return line
    let row: TurnRecord
    try {
      row = JSON.parse(line) as TurnRecord
    } catch {
      return line
    }
    const other = rebuilt.get(row.index)
    if (
      other === undefined ||
      row.uuid === undefined ||
      row.endedAt !== row.startedAt ||
      other.endedAt === row.endedAt ||
      other.uuid !== row.uuid ||
      other.prompt !== row.prompt ||
      other.reply !== row.reply ||
      other.startedAt !== row.startedAt
    ) {
      return line
    }
    patchedRows += 1
    process.stdout.write(
      `${agent.name ?? agent.id} #${row.index}: endedAt ${row.endedAt} -> ${other.endedAt} ` +
        `(+${other.endedAt - row.endedAt}ms)\n`
    )
    return JSON.stringify({ ...row, endedAt: other.endedAt })
  })

  if (next.join('\n') === lines.join('\n')) continue
  patchedFiles += 1
  if (!APPLY) continue
  mkdirSync(BACKUP_DIR, { recursive: true })
  copyFileSync(ledgerFile, path.join(BACKUP_DIR, `${agent.id}.jsonl`))
  const tmp = `${ledgerFile}.migrate-tmp`
  writeFileSync(tmp, next.join('\n'), 'utf8')
  renameSync(tmp, ledgerFile)
}

process.stdout.write(
  `${APPLY ? 'patched' : 'would patch'} ${patchedRows} row(s) across ${patchedFiles} file(s)` +
    `${APPLY && patchedFiles > 0 ? `; backups in ${BACKUP_DIR}` : ''}\n`
)
