#!/usr/bin/env node
// THE CHECKPOINT GATE. Two claims, printed separately, per Claude card.
//
//   REACH   NO CHECKPOINT IS UNREACHABLE — every session id ever bound to the
//           card is still in (binding ∪ lineage ∪ spill) and names a
//           transcript that is on disk. FAIL means checkpoints the owner had
//           can no longer be opened from the rail. This is the claim the
//           20-entry lineage cap broke on 2026-09-06, silently.
//   LIVE    the card is bound to the session its pane's process reports, for
//           cards whose pane agent can be IDENTIFIED. Anything else is
//           UNKNOWN — see below.
//
//   npm run gate:checkpoints            (exit 1 on any FAIL or MISMATCH)
//
// WHY THE LIVE HALF WAS REWRITTEN. It used to join terminal → pid by scanning
// `ps -axEo` for COOKREW_TERMINAL_ID and taking A matching pid. A BACKGROUND
// job inherits that variable from the session that spawned it and writes its
// own ~/.claude/sessions/<pid>.json, so on 2026-09-06 the gate picked the job
// and printed MISMATCH for Conductor — a card that was correctly bound
// (295d5f1c) against a "live" session (a78aa3e5) that was a background job of
// that very session. The app's oracle had refused bg holders all along. The
// rule now lives in ONE module both import (src/shared/pane-agent.mjs) and an
// undecidable pane prints UNKNOWN, never an alarm: a gate that cries wolf is
// how a real mismatch gets ignored.
//
// No app API, no herdr: the gate must run while the app is the thing under
// suspicion. Prints ids truncated; never a token, never a path outside
// ~/.cookrew and ~/.claude.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolvePaneAgent, withoutDescendantsOfPeers } from '../src/shared/pane-agent.mjs'
import { liveVerdict, reachVerdict } from '../src/shared/checkpoint-gate.mjs'
import { SPILL_DIR_NAME, parseSpill } from '../src/shared/lineage-spill-format.mjs'

const HOME = homedir()
const SESSIONS = path.join(HOME, '.claude', 'sessions')
const PROJECTS = path.join(HOME, '.claude', 'projects')
const COOKREW = path.join(HOME, '.cookrew')
const WORKSPACES = path.join(COOKREW, 'workspaces')
const SPILLS = path.join(COOKREW, SPILL_DIR_NAME)
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
      if (typeof record.sessionId === 'string') records.set(pid, { pid, ...record })
    } catch {
      // half-written; the next run sees it
    }
  }
  return records
}

/** One `ps` for everything the join needs: terminal id, and the parent pid. */
function processTable() {
  const byTerminal = new Map()
  const parents = new Map()
  const listing = execFileSync('ps', ['-axEo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  for (const line of listing.split('\n')) {
    const head = /^\s*(\d+)\s+(\d+)\s/.exec(line)
    if (!head) continue
    const pid = Number(head[1])
    parents.set(pid, Number(head[2]))
    const terminal = /COOKREW_TERMINAL_ID=([0-9a-f-]{36})/.exec(line)?.[1]
    if (!terminal) continue
    byTerminal.set(terminal, [...(byTerminal.get(terminal) ?? []), pid])
  }
  return { byTerminal, ppidOf: (pid) => parents.get(pid) ?? null }
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

/** The durable lineage record for a node — the copy that outlives the array. */
function spillIdsOf(terminalId) {
  try {
    return parseSpill(readFileSync(path.join(SPILLS, `${terminalId}.json`), 'utf8'), terminalId).ids
  } catch {
    return []
  }
}

/**
 * Ids the app itself recorded binding to this card, as 8-char witnesses.
 *
 * The event log is the INDEPENDENT witness the reach claim needs: it was
 * written when the rotation happened, by the app, and it is not the structure
 * under test. It rotates (events.1.jsonl …), so its silence proves nothing —
 * only what it names is evidence.
 */
function everBoundOf(nodes) {
  const witnesses = new Map()
  for (const name of readdirSync(COOKREW).filter((n) => /^events(\.\d+)?\.jsonl$/.test(n))) {
    let lines = []
    try {
      lines = readFileSync(path.join(COOKREW, name), 'utf8').split('\n')
    } catch {
      continue
    }
    for (const line of lines) {
      if (!line.includes('session-rotated')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!nodes.has(event.entityId)) continue
      const ids = String(event.details ?? '').match(/[0-9a-f]{8}/g) ?? []
      witnesses.set(event.entityId, new Set([...(witnesses.get(event.entityId) ?? []), ...ids]))
    }
  }
  return witnesses
}

/** Both verdicts for one card. */
function rowFor({ workspace, node }, context) {
  const { records, byTerminal, ppidOf, witnesses } = context
  const holders = (byTerminal.get(node.id) ?? [])
    .map((pid) => records.get(pid))
    .filter((record) => record !== undefined)
  const resolution = resolvePaneAgent({
    holders: withoutDescendantsOfPeers(holders, ppidOf),
    cwd: node.cwd ?? ''
  })
  const bound = node.claudeSessionId ?? null
  const live = liveVerdict(bound, resolution)
  const dir = projectDir(node.cwd ?? '')
  const reach = reachVerdict({
    bound,
    lineage: node.sessionLineage ?? [],
    spillIds: spillIdsOf(node.id),
    everBound: [...(witnesses.get(node.id) ?? [])],
    hasTranscript: (id) => existsSync(path.join(dir, `${id}.jsonl`))
  })
  return {
    reach: reach.verdict,
    live: live.verdict,
    workspace,
    card: node.name ?? node.id.slice(0, 8),
    bound: bound ? `${bound.slice(0, 8)} (${ageOf(path.join(dir, `${bound}.jsonl`))})` : '—',
    chain: String(reach.chain.length),
    pane: resolution.agent ? String(resolution.agent.pid) : '—',
    detail: [
      live.detail,
      reach.missing.length ? `DROPPED FROM THE CHAIN: ${reach.missing.join(' ')}` : '',
      reach.gone.length
        ? `TRANSCRIPT GONE: ${reach.gone.map((id) => id.slice(0, 8)).join(' ')}`
        : '',
      reach.unwritten.length
        ? `never written: ${reach.unwritten.map((id) => id.slice(0, 8)).join(' ')}`
        : ''
    ]
      .filter(Boolean)
      .join('; ')
  }
}

const records = liveRecords()
const { byTerminal, ppidOf } = processTable()
const cards = claudeNodes()
const witnesses = everBoundOf(new Set(cards.map(({ node }) => node.id)))
const rows = cards.map((card) => rowFor(card, { records, byTerminal, ppidOf, witnesses }))

if (rows.length === 0) {
  console.log('checkpoint-gate: no Claude card found')
  process.exit(0)
}

const columns = ['reach', 'live', 'workspace', 'card', 'bound', 'chain', 'pane', 'detail']
const width = (key) => Math.max(key.length, ...rows.map((r) => String(r[key]).length))
const line = (row) => columns.map((c) => String(row[c]).padEnd(width(c))).join('  ').trimEnd()
console.log(line(Object.fromEntries(columns.map((c) => [c, c]))))
for (const row of rows) console.log(line(row))

const unreachable = rows.filter((r) => r.reach === 'FAIL')
const mismatched = rows.filter((r) => r.live === 'MISMATCH')
const unknown = rows.filter((r) => r.live === 'UNKNOWN')
console.log(
  `\nREACH  ${rows.length - unreachable.length}/${rows.length} card(s) can reach every session ` +
    'ever bound to them (binding u lineage u spill)'
)
console.log(
  `LIVE   ${rows.length - mismatched.length - unknown.length}/${rows.length} card(s) bound to the ` +
    `session their pane process writes, ${unknown.length} undecidable (UNKNOWN is not an alarm)`
)
const failed = unreachable.length + mismatched.length
console.log(
  failed === 0
    ? 'checkpoint-gate: PASS'
    : `checkpoint-gate: FAIL — ${unreachable.length} unreachable, ${mismatched.length} mismatched`
)
process.exit(failed === 0 ? 0 : 1)
