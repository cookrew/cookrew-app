// WHAT THE CHECKPOINT GATE READS OFF DISK — the owner's own files, gathered.
// Every rule that JUDGES what is gathered here is pure and lives elsewhere
// (src/shared/checkpoint-gate.mjs); this file only ever answers "what is
// there", so the gate script stays a page of orchestration and printing.
//
// THE READS: the durable lineage record (with the stamp that dates a binding),
// the event log's rotations, the persisted stream index, a card's mark ledger,
// and the head of a transcript. Nothing here throws — a read that fails is an
// absence of evidence, and a gate that crashes on a torn file is a gate that
// stops being run.
//
// WHAT SAYS A TRANSCRIPT WAS EVER WRITTEN
//
// SCOUT, 2026-09-07. The gate failed a card over `TRANSCRIPT GONE: b0d36b55`,
// an id the app minted when it bound a fresh terminal and replaced sixteen
// seconds later with the session the process really writes. Nothing was ever
// written under it. The gate had been treating a rotation event that NAMES an
// id as proof the id once had a transcript, so a placeholder read as data
// loss. Failing now needs positive evidence, and this is where that evidence
// is gathered from the owner's own files.
//
// TWO SOURCES, BOTH RECORDS RATHER THAN INFERENCES:
//
//   the persisted stream index (~/.cookrew/stream/<terminal>.json) — the app's
//   own note of which transcripts it read blocks OUT of, including the replay
//   copies and the predecessor each rotation boundary came from. Reading the
//   app's answer instead of re-deriving it is the rule the marks line already
//   follows;
//
//   the transcripts themselves — a compaction writes an `isCompactSummary`
//   record carrying its predecessor's id, which is claude's own join and not
//   anybody's guess. Only the head of each file is read.
//
// A THIRD ONE IS DELIBERATELY ABSENT. The old turn store (~/.cookrew/turns)
// is keyed by TERMINAL, and its records carry index/prompt/reply/uuid and no
// session id at all (measured on Forge, 2026-09-07), so a record there cannot
// be attributed to the session that was bound when it was written. The pure
// rule accepts `inTurnStore` for the day the store can answer that; this gate
// does not claim it can.
//
// No app API and no herdr: the gate must run while the app is the thing under
// suspicion. Reads nothing outside ~/.cookrew and ~/.claude.

import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'
import { parseSpill } from '../src/shared/lineage-spill-format.mjs'

/**
 * How much of a transcript's front is read when looking for its compaction.
 *
 * The pair sits within the first couple of dozen lines, behind the chrome
 * claude writes first (ai-title, agent-name, mode). One MiB is generous room
 * for a summary record that can itself run tens of kilobytes, and it is still
 * a bounded head read — one measured chain is 119 + 91 + 91 + 71 MB and is
 * never held whole.
 */
const HEAD_BYTES = 1024 * 1024

/** How many head lines are examined, mirroring LINEAGE_HEAD_LINES. */
const HEAD_LINES = 256

/** The session a transcript path names, or null when it names none. */
export function sessionIdOfFile(file) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return null
  const name = path.basename(file, '.jsonl')
  return name.length > 0 ? name : null
}

/** The head of a file as lines, without a torn last one. Never throws. */
function headLinesOf(file) {
  let fd
  try {
    fd = openSync(file, 'r')
  } catch {
    return []
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    const lines = buffer.subarray(0, read).toString('utf8').split('\n')
    // A file longer than the window ends mid-line: that line is not judged.
    if (read === HEAD_BYTES) lines.pop()
    return lines.slice(0, HEAD_LINES)
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
}

/**
 * The predecessors the transcripts in `files` declare they compacted.
 *
 * The AUTHORITY on reading a rotation edge is claude-rotation.ts, whose
 * rotationEdgeOf refuses a summary without its boundary and tells an
 * INHERITED compaction pair from an own one. Both of those cares exist to
 * avoid a wrong JOIN — splicing a stranger's checkpoints onto this card's
 * rail. The question here is not which file follows which; it is whether a
 * session was ever written at all, and an inherited pair names the
 * grandparent, which was also written. So this read is the liberal one on
 * purpose: it can only ever add a true existence, and it errs toward the
 * strict invariant rather than away from it.
 */
export function compactionPredecessorsOf(files) {
  const predecessors = new Set()
  for (const file of new Set(files)) {
    for (const line of headLinesOf(file)) {
      if (!line.includes('isCompactSummary')) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.isCompactSummary !== true) continue
      const predecessor = record.session_id
      if (typeof predecessor !== 'string' || predecessor === record.sessionId) continue
      predecessors.add(predecessor)
    }
  }
  return predecessors
}

/**
 * What the app materialised for one card, or null when it has materialised
 * nothing. Null is not "no evidence against" — it is NO ANSWER, and the
 * caller claims nothing from it.
 *
 * `files` is every session whose transcript the index says blocks were read
 * OUT of: the row's own file, the replay copies that also hold the exchange,
 * and the occurrence list behind them. The `cursor` is deliberately not among
 * them — it is where the reader stands, not what it read, and a card the app
 * merely opened must not be evidence that anything was written.
 * `predecessors` is the rotation boundaries' `previousSessionId` — the same
 * compaction fact, already resolved by the walk. `paths` is the absolute set,
 * so the head scan above can reach files that are not on this card's chain.
 */
export function streamEvidenceOf(streamDir, terminalId) {
  let state
  try {
    state = JSON.parse(readFileSync(path.join(streamDir, `${terminalId}.json`), 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(state?.index)) return null
  const files = new Set()
  const paths = new Set()
  const predecessors = new Set()
  const identities = new Set()
  const add = (file) => {
    const id = sessionIdOfFile(file)
    if (id === null) return
    files.add(id)
    paths.add(file)
  }
  for (const row of state.index) {
    add(row?.file)
    for (const occurrence of row?.occurrences ?? []) add(occurrence?.file)
    for (const replay of row?.replayedIn ?? []) add(replay)
    if (typeof row?.previousSessionId === 'string') predecessors.add(row.previousSessionId)
    if (typeof row?.identity === 'string') identities.add(row.identity)
  }
  return { files, paths, predecessors, identities }
}

/**
 * The durable lineage record for a card — the copy that outlives the node's
 * array, and the only place that DATES a binding (`boundAt`, one stamp per
 * id). An absent record is an empty one: the caller merges what it has on top.
 */
export function spillOf(spillsDir, terminalId) {
  try {
    return parseSpill(readFileSync(path.join(spillsDir, `${terminalId}.json`), 'utf8'), terminalId)
  } catch {
    return { ids: [], boundAt: {} }
  }
}

/**
 * The identities a card's mark ledger holds, folded last-wins.
 *
 * Only the KEYS are read: a mark's title is the owner's text and this gate
 * prints nothing but ids. A ledger that does not exist is not an absence of
 * marks to worry about — it is a card nobody has titled.
 */
export function markIdentities(marksDir, terminalId) {
  let text
  try {
    text = readFileSync(path.join(marksDir, `${terminalId}.jsonl`), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  // A file not ending in a newline has a torn tail (marks.ts): drop it.
  if (text.length > 0 && !text.endsWith('\n')) lines.pop()
  const identities = new Set()
  for (const line of lines) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed?.identity === 'string') identities.add(parsed.identity)
    } catch {
      // a line this gate cannot read is a line it does not judge
    }
  }
  return [...identities]
}

/**
 * What the app itself recorded about a set of cards' rotations.
 *
 * The event log is the INDEPENDENT witness the derived claims need: it was
 * written when the rotation happened, by the app, and it is not the structure
 * under test. It rotates (events.1.jsonl …), so its silence proves nothing —
 * only what it names is evidence.
 *
 * Three readings of the same `terminal.session-rotated` details ("<from> →
 * <to>"): the SET of 8-char ids ever bound (reach), the ORDERED list of
 * destinations (flap — a destination that repeats is a card alternating), and
 * WHEN each id was rotated AWAY from, which with the spill's `boundAt` closes
 * the interval an id was held for. Sixteen seconds is a mint being replaced at
 * spawn; hours are a conversation (Scout, 2026-09-07).
 */
export function rotationsOf(cookrewDir, nodes) {
  const witnesses = new Map()
  const hops = new Map()
  const departures = new Map()
  for (const name of eventFilesIn(cookrewDir)) {
    for (const line of linesOf(path.join(cookrewDir, name))) {
      if (!line.includes('session-rotated')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!nodes.has(event.entityId)) continue
      const ids = String(event.details ?? '').match(/[0-9a-f]{8}/g) ?? []
      if (ids.length === 0) continue
      const at = Number(event.timestamp) || 0
      witnesses.set(event.entityId, new Set([...(witnesses.get(event.entityId) ?? []), ...ids]))
      hops.set(event.entityId, [...(hops.get(event.entityId) ?? []), { at, to: ids[ids.length - 1] }])
      if (ids.length > 1 && at > 0) noteDeparture(departures, event.entityId, ids[0], at)
    }
  }
  // The rotated files are read after the live one, so order by the timestamp
  // the app wrote rather than by the order the lines were gathered.
  const destinations = new Map(
    [...hops].map(([id, list]) => [id, [...list].sort((a, b) => a.at - b.at).map((hop) => hop.to)])
  )
  return { witnesses, destinations, departures }
}

function eventFilesIn(cookrewDir) {
  try {
    return readdirSync(cookrewDir).filter((name) => /^events(\.\d+)?\.jsonl$/.test(name))
  } catch {
    return []
  }
}

function linesOf(file) {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

/**
 * When a card LEFT an id, keeping the FIRST time it did. A later re-departure
 * (a flap rotating back and away again) would over-state how long the id was
 * held, and the hold is what decides whether an absent transcript was ever
 * written at all.
 */
function noteDeparture(departures, entityId, from, at) {
  const left = departures.get(entityId) ?? new Map()
  const known = left.get(from)
  departures.set(entityId, new Map([...left, [from, known === undefined ? at : Math.min(known, at)]]))
}
