#!/usr/bin/env node
// THE CHECKPOINT ⇔ LIVE-TRANSCRIPT GATE, live half.
//
// For every Claude card in every workspace whose pane process is running,
// the session the card is bound to (what the rail reads) must be the session
// the process itself reports in ~/.claude/sessions/<pid>.json. Anything else
// is a rail lying about a live terminal. Exit 1 on any MISMATCH.
//
//   npm run gate:checkpoints
//
// Joins: workspace.json node → pane process (the process environment carries
// COOKREW_TERMINAL_ID; `ps -E` prints it for processes we own) → claude's own
// per-pid record. No app API, no herdr call: the gate must be able to run
// while the app is the thing under suspicion. Prints ids truncated; never a
// token, never a path outside ~/.cookrew and ~/.claude.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const HOME = homedir()
const SESSIONS = path.join(HOME, '.claude', 'sessions')
const PROJECTS = path.join(HOME, '.claude', 'projects')
const WORKSPACES = path.join(HOME, '.cookrew', 'workspaces')
const CLAUDE_COMMAND = /^claude(\s|$)/

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** pid → claude's live record, for live processes only. */
function liveRecords() {
  const records = new Map()
  let names = []
  try {
    names = readdirSync(SESSIONS)
  } catch {
    return records
  }
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (!alive(pid)) continue
    try {
      const record = JSON.parse(readFileSync(path.join(SESSIONS, name), 'utf8'))
      if (typeof record.sessionId === 'string') records.set(pid, record)
    } catch {
      // half-written; the next run sees it
    }
  }
  return records
}

/** terminal id → pid, from the environment of our own processes. */
function pidsByTerminal(known) {
  const out = new Map()
  const listing = execFileSync('ps', ['-axEo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  for (const line of listing.split('\n')) {
    const terminal = /COOKREW_TERMINAL_ID=([0-9a-f-]{36})/.exec(line)?.[1]
    if (!terminal) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (known.has(pid)) out.set(terminal, pid)
  }
  return out
}

function projectDir(cwd) {
  return path.join(PROJECTS, cwd.replace(/[/.]/g, '-'))
}

function ageOf(file) {
  if (!existsSync(file)) return 'no file'
  const minutes = Math.round((Date.now() - statSync(file).mtimeMs) / 60_000)
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

function claudeNodes() {
  const nodes = []
  for (const id of readdirSync(WORKSPACES)) {
    const file = path.join(WORKSPACES, id, 'workspace.json')
    if (!existsSync(file)) continue
    let workspace
    try {
      workspace = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const node of workspace.nodes ?? []) {
      if (node.kind !== 'terminal' || !CLAUDE_COMMAND.test(node.command ?? '')) continue
      nodes.push({ workspace: workspace.name ?? id.slice(0, 8), node })
    }
  }
  return nodes
}

const records = liveRecords()
const pids = pidsByTerminal(records)
const rows = []
let mismatches = 0
for (const { workspace, node } of claudeNodes()) {
  const pid = pids.get(node.id)
  if (!pid) continue // no live pane: nothing to hold the binding to
  const record = records.get(pid)
  const bound = node.claudeSessionId ?? null
  const live = record.sessionId
  const dir = projectDir(node.cwd ?? '')
  const ok = bound === live
  if (!ok) mismatches++
  rows.push({
    verdict: ok ? 'OK' : 'MISMATCH',
    workspace,
    card: node.name ?? node.id.slice(0, 8),
    pid,
    bound: bound ? `${bound.slice(0, 8)} (${ageOf(path.join(dir, `${bound}.jsonl`))})` : '—',
    live: `${live.slice(0, 8)} (${ageOf(path.join(dir, `${live}.jsonl`))}, ${record.status ?? '?'})`,
    lineage: (node.sessionLineage ?? []).length
  })
}

if (rows.length === 0) {
  console.log('checkpoint-live-gate: no Claude card with a live pane process found')
  process.exit(0)
}
const width = (key) => Math.max(key.length, ...rows.map((r) => String(r[key]).length))
const columns = ['verdict', 'workspace', 'card', 'pid', 'bound', 'live', 'lineage']
const line = (row) => columns.map((c) => String(row[c]).padEnd(width(c))).join('  ')
console.log(line(Object.fromEntries(columns.map((c) => [c, c]))))
for (const row of rows) console.log(line(row))
console.log(
  mismatches === 0
    ? `\ncheckpoint-live-gate: PASS — ${rows.length} card(s) bound to the session their process writes`
    : `\ncheckpoint-live-gate: FAIL — ${mismatches} of ${rows.length} card(s) show a rail that is not the live transcript`
)
process.exit(mismatches === 0 ? 0 : 1)
