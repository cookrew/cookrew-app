#!/usr/bin/env node
// THE CHECKPOINT GATE. Four claims, printed separately, per Claude card.
//
//   REACH   NO CHECKPOINT IS UNREACHABLE — every session id ever bound to the
//           card is still in (binding ∪ lineage ∪ spill) and names a
//           transcript that is on disk. FAIL means checkpoints the owner had
//           can no longer be opened from the rail. This is the claim the
//           20-entry lineage cap broke on 2026-09-06, silently. An absent
//           transcript only FAILS when something says it was ever written
//           (checkpoint-gate-lib.mjs gathers that; transcriptEvidence judges
//           it): the app MINTS a session id when it binds a fresh terminal,
//           and Scout's placeholder — bound 11:34:19, replaced at 11:34:35,
//           never written to — was being reported as sixteen seconds of lost
//           history (2026-09-07). Ids like it are printed as `never written`,
//           with the reason, and do not fail the run.
//   LIVE    the card is bound to the session its pane's process reports, for
//           cards whose pane agent can be IDENTIFIED. Anything else is
//           UNKNOWN — see below.
//   FLAP    the card is NOT alternating between two sessions — no rotation
//           destination in its recent event log repeats. Reported only, never
//           a failure: a flap is a wrong rail and a noisy history, not a lost
//           checkpoint (2026-09-06, Conductor: 295d5f1c <-> a78aa3e5 x8, the
//           spawn-time adoption defect claude-session-adoption.ts ends).
//   MARKS   every mark's identity resolves to a row in the card's stream —
//           the one-stream design's own line: "The reachability gate from
//           yesterday stays and gains one line: every mark's identity
//           resolves to a block in the stream. An orphan mark is reported,
//           never dropped." REPORTED, never a failure, for the same reason
//           FLAP is: an orphan mark is a title with nowhere to sit, not a
//           lost checkpoint, and the mark is still on disk for the day its
//           transcript comes back.
//
// WHERE THE MARKS LINE GETS ITS ANSWER, and why it is not a parse. Resolving
// an identity properly means walking the chain and materialising the index,
// which is the app's job and would make this gate read 400 MB of transcript
// per card. It does not have to: the app already writes what it materialised
// to ~/.cookrew/stream/<id>.json (the shared cursor, T2.5), whose `index`
// carries one identity per row. So the gate reads the app's OWN answer — the
// same read-the-record-rather-than-re-derive-it rule the LIVE half follows —
// and a card whose state has not been written yet says so ("not materialised")
// instead of claiming every one of its marks is an orphan.
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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolvePaneAgent, withoutDescendantsOfPeers } from '../src/shared/pane-agent.mjs'
import { flapVerdict, liveVerdict, marksVerdict, reachVerdict } from '../src/shared/checkpoint-gate.mjs'
import { SPILL_DIR_NAME, unionLineage } from '../src/shared/lineage-spill-format.mjs'
import {
  compactionPredecessorsOf,
  markIdentities,
  rotationsOf,
  spillOf,
  streamEvidenceOf
} from './checkpoint-gate-lib.mjs'

const HOME = homedir()
const SESSIONS = path.join(HOME, '.claude', 'sessions')
const PROJECTS = path.join(HOME, '.claude', 'projects')
const COOKREW = path.join(HOME, '.cookrew')
const WORKSPACES = path.join(COOKREW, 'workspaces')
const SPILLS = path.join(COOKREW, SPILL_DIR_NAME)
const MARKS = path.join(COOKREW, 'marks')
const STREAM_STATE = path.join(COOKREW, 'stream')
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

/**
 * Where claude keeps a card's transcripts — the REALPATH's slug.
 *
 * This gate had its own copy of the rule (`cwd.replace(/[/.]/g, '-')`, no
 * realpath) and the copy had drifted from claude-fork.ts twice over: the app
 * resolves the symlink first, because claude keys the directory by the path
 * the agent process sees (macOS /tmp → /private/tmp, the R2 recover incident),
 * and it slugs every non-alphanumeric character, not just dots and slashes.
 * The five Playground cards live in /tmp, so the gate was looking in a
 * directory that does not exist and reporting every one of their transcripts
 * as absent — visible only once the evidence rule started asking whether the
 * absent ones had ever been written, and the app's own index answered that it
 * had read twenty-one blocks out of one of them.
 *
 * The .ts modules cannot be imported from a plain node script, so this is a
 * restatement; it is kept character-for-character with claudeProjectSlug and
 * realCwd, which are the authority.
 */
function projectDir(cwd) {
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {
    // A cwd that no longer exists is slugged as it was written.
  }
  return path.join(PROJECTS, real.replace(/[^a-zA-Z0-9-]/g, '-'))
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

/**
 * WHAT THE GATE CAN SHOW FOR AN ID WHOSE TRANSCRIPT IS NOT ON DISK — the
 * facts src/shared/checkpoint-gate.mjs judges, gathered per card.
 *
 * `heldMs` is a CLOSED interval and nothing else: the spill's `boundAt` to the
 * event log's rotation off it. An id still bound is never "held" evidence — a
 * card can sit bound for days without ever booting, and reading its age as a
 * hold would fail every dormant card on the canvas. A negative interval is no
 * interval either: the durable record was introduced with a migration that
 * stamped everything a node already carried at one instant, so an id whose
 * rotation PREDATES its stamp was never dated at all (Forge's 699e207e:
 * stamped 15:44:12.927Z, rotated away two hours earlier).
 */
function factsGatherer({ spill, stream, predecessors, departed }) {
  return (id) => {
    const boundAt = Date.parse(spill.boundAt?.[id] ?? '')
    const replacedAt = departed.get(id.slice(0, 8))
    const dated = Number.isFinite(boundAt) && replacedAt !== undefined && replacedAt > boundAt
    return {
      inStreamIndex: stream?.files.has(id) === true,
      namedByCompaction: predecessors.has(id) || stream?.predecessors.has(id) === true,
      heldMs: dated ? replacedAt - boundAt : null
    }
  }
}

/** An absent transcript with the sentence the pure rule wrote about it. */
function said(absent) {
  return `${absent.id.slice(0, 8)} (${absent.reason})`
}

/** All four verdicts for one card. */
function rowFor({ workspace, node }, context) {
  const { records, byTerminal, ppidOf, witnesses, destinations, departures } = context
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
  const spill = spillOf(SPILLS, node.id)
  const lineage = node.sessionLineage ?? []
  const hasTranscript = (id) => existsSync(path.join(dir, `${id}.jsonl`))
  const stream = streamEvidenceOf(STREAM_STATE, node.id)
  // Only files that ARE there can say anything about the ones that are not.
  const readable = unionLineage(spill.ids, lineage, bound ? [bound] : [])
    .filter(hasTranscript)
    .map((id) => path.join(dir, `${id}.jsonl`))
  const reach = reachVerdict({
    bound,
    lineage,
    spillIds: spill.ids,
    everBound: [...(witnesses.get(node.id) ?? [])],
    hasTranscript,
    factsFor: factsGatherer({
      spill,
      stream,
      predecessors: compactionPredecessorsOf([...readable, ...(stream?.paths ?? [])]),
      departed: departures.get(node.id) ?? new Map()
    })
  })
  const flap = flapVerdict({ rotations: destinations.get(node.id) ?? [] })
  const marks = marksVerdict({
    identities: markIdentities(MARKS, node.id),
    // Null and empty are different facts: a card the app has never opened has
    // no answer, and reporting its marks as orphans would be an alarm about
    // the gate's own timing.
    placed: stream?.identities ?? null
  })
  return {
    reach: reach.verdict,
    live: live.verdict,
    flap: flap.verdict === 'FLAP' ? flap.ids.join('/') : '',
    marks:
      marks.orphans.length > 0 ? `${marks.orphans.length}/${marks.marks}` : String(marks.marks),
    marksVerdict: marks.verdict,
    orphanMarks: marks.orphans.length,
    markCount: marks.marks,
    workspace,
    card: node.name ?? node.id.slice(0, 8),
    bound: bound ? `${bound.slice(0, 8)} (${ageOf(path.join(dir, `${bound}.jsonl`))})` : '—',
    chain: String(reach.chain.length),
    pane: resolution.agent ? String(resolution.agent.pid) : '—',
    detail: [
      live.detail,
      marks.detail,
      reach.missing.length ? `DROPPED FROM THE CHAIN: ${reach.missing.join(' ')}` : '',
      reach.gone.length ? `TRANSCRIPT GONE: ${reach.gone.map(said).join(', ')}` : '',
      reach.unwritten.length ? `never written: ${reach.unwritten.map(said).join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('; ')
  }
}

const records = liveRecords()
const { byTerminal, ppidOf } = processTable()
const cards = claudeNodes()
const { witnesses, destinations, departures } = rotationsOf(
  COOKREW,
  new Set(cards.map(({ node }) => node.id))
)
const rows = cards.map((card) =>
  rowFor(card, { records, byTerminal, ppidOf, witnesses, destinations, departures })
)

if (rows.length === 0) {
  console.log('checkpoint-gate: no Claude card found')
  process.exit(0)
}

const columns = ['reach', 'live', 'marks', 'workspace', 'card', 'bound', 'chain', 'pane', 'detail']
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
const flapping = rows.filter((r) => r.flap !== '')
console.log(
  `FLAP   ${flapping.length} card(s) rotating back onto a session they already left ` +
    '(reported, never a failure)' +
    (flapping.length === 0 ? '' : `: ${flapping.map((r) => `${r.card} ${r.flap}`).join(', ')}`)
)
// ONE STREAM T4: reported, never a failure. A mark whose identity reaches no
// row is evidence a transcript moved, and the mark is still on disk.
const withOrphans = rows.filter((r) => r.orphanMarks > 0)
const undecidableMarks = rows.filter((r) => r.marksVerdict === 'UNKNOWN')
console.log(
  `MARKS  ${rows.reduce((sum, r) => sum + r.markCount - r.orphanMarks, 0)} of ` +
    `${rows.reduce((sum, r) => sum + r.markCount, 0)} mark(s) resolve to a stream row ` +
    '(reported, never a failure)' +
    (withOrphans.length === 0
      ? ''
      : `: ${withOrphans.map((r) => `${r.card} ${r.orphanMarks}`).join(', ')}`) +
    (undecidableMarks.length === 0
      ? ''
      : ` — ${undecidableMarks.length} card(s) undecidable (no stream index written yet)`)
)

const failed = unreachable.length + mismatched.length
console.log(
  failed === 0
    ? 'checkpoint-gate: PASS'
    : `checkpoint-gate: FAIL — ${unreachable.length} unreachable, ${mismatched.length} mismatched`
)
process.exit(failed === 0 ? 0 : 1)
