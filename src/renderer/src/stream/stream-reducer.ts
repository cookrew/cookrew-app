// THE STREAM'S STATE, AS PURE FUNCTIONS (one-stream T3).
//
// WHY A REDUCER AND NOT FIVE useStates. The thing this replaces was two
// fetches joined in the renderer by a key that could drift, plus a clamp that
// invented rows when the join failed. The failure was never in the fetching —
// it was that nobody could state, in one place, what the rail believed. So
// every transition the stream can make is a pure function over one object
// here, and useStream is only the plumbing that feeds it.
//
// IMMUTABLE THROUGHOUT. Blocks come out of a cache the reader extends IN
// PLACE (trace.ts's own contract), so a reducer that mutated its input would
// be mutating the reader's memory. Every case below builds new objects.
//
// ONE COORDINATE. Rows are keyed by `identity` and ordered by `ordinal`.
// There is no second numbering to reconcile, so there is no clamp, no
// "phantom row" and no earlier-segment drop — the three behaviours
// mergeCheckpointRows existed to paper over.

import type {
  LiveState,
  MarkPatch,
  RollbackNote,
  StreamBlock,
  StreamCheckpoint,
  StreamMarks,
  StreamOpen,
  StreamTail,
  TranscriptSource
} from './stream-types'

export interface StreamState {
  readonly terminalId: string
  /** The rail: every position this client has heard of, ascending by ordinal. */
  readonly index: readonly StreamCheckpoint[]
  /** The drawer's cache, by identity. Never by position — a position moves. */
  readonly blocks: Readonly<Record<string, StreamBlock>>
  readonly tail: StreamTail | null
  /** Length of the WHOLE stream, which is not the number of rows loaded. */
  readonly total: number
  /** Cursor for the next page BACKWARDS, or null at the stream's oldest. */
  readonly backwardsCursor: string | null
  readonly anomalies: Readonly<Record<string, number>>
  readonly rolledBack: readonly RollbackNote[]
  readonly live: LiveState
  readonly source: TranscriptSource | null
  /** True once an open (or its fallback) has answered — "empty" vs "not yet". */
  readonly opened: boolean
  /** The last failure, kept so the rail can say why rather than show nothing. */
  readonly error: string | null
}

export type StreamAction =
  | { kind: 'reset'; terminalId: string }
  | { kind: 'open'; open: StreamOpen }
  | {
      kind: 'index'
      checkpoints: readonly StreamCheckpoint[]
      backwardsCursor?: string | null
      total?: number
    }
  | { kind: 'tail'; tail: StreamTail }
  | { kind: 'mark'; identity: string; mark: StreamMarks | null }
  | { kind: 'rollback'; fromOrdinal: number; at: number }
  | {
      kind: 'blocks'
      blocks: readonly StreamBlock[]
      marks?: Readonly<Record<string, StreamMarks>>
      total?: number
    }
  | { kind: 'live'; live: LiveState }
  | { kind: 'error'; error: string | null }

export function initialStreamState(terminalId: string): StreamState {
  return {
    terminalId,
    index: [],
    blocks: {},
    tail: null,
    total: 0,
    backwardsCursor: null,
    anomalies: {},
    rolledBack: [],
    live: 'off',
    source: null,
    opened: false,
    error: null
  }
}

/** Ascending by ordinal, deduplicated by identity — the rail's only order. */
function ordered(rows: readonly StreamCheckpoint[]): StreamCheckpoint[] {
  return [...rows].sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * Merge rows by IDENTITY, incoming wins on the stream's own facts and the
 * prior row's marks survive when the incoming carries none.
 *
 * The marks rule matters: `/stream/index` may answer a page-back with rows
 * whose marks were not folded in (a door card, an older server), and a page
 * that silently cleared a Sous title would look exactly like Sous having
 * withdrawn one. A cleared title arrives as a `mark` event with `null`, which
 * is the only thing that removes one.
 */
export function mergeIndex(
  current: readonly StreamCheckpoint[],
  incoming: readonly StreamCheckpoint[]
): readonly StreamCheckpoint[] {
  const byIdentity = new Map<string, StreamCheckpoint>()
  for (const row of current) byIdentity.set(row.identity, row)
  let changed = false
  for (const row of incoming) {
    const prior = byIdentity.get(row.identity)
    const next =
      prior?.marks !== undefined && row.marks === undefined ? { ...row, marks: prior.marks } : row
    if (prior === undefined || !sameRow(prior, next)) changed = true
    byIdentity.set(row.identity, next)
  }
  // A LIVE TAIL TICKS FOREVER, and a merge that always returned a new array
  // would give the rail a new identity every second: the rows re-project, the
  // pager rebuilds, and the drawer's coalescing single-flight is thrown away
  // mid-fetch. So an unchanged merge is the SAME array, and every memo
  // downstream is allowed to mean what it says.
  // Nothing new and nothing different: `current` is already ordered, so it IS
  // the answer. (A new identity always sets `changed`, so the map cannot have
  // grown without the flag.)
  if (!changed) return current
  return ordered([...byIdentity.values()])
}

/** Two rows are the same when nothing the rail draws from them differs. */
function sameRow(a: StreamCheckpoint, b: StreamCheckpoint): boolean {
  return (
    a.identity === b.identity &&
    a.ordinal === b.ordinal &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.promptHead === b.promptHead &&
    a.compacted === b.compacted &&
    a.rolledBack === b.rolledBack &&
    JSON.stringify(a.marks ?? null) === JSON.stringify(b.marks ?? null)
  )
}

/**
 * The rail row a block implies, keeping whatever was attached to it.
 *
 * A live `tail` carries the block, not the row, so the rail's newest entry is
 * derived here rather than waiting for an index re-read — which is what the
 * old rail did (fetch the index delta after the tracker decided a turn ended)
 * and why a finished turn could sit un-railed for a beat.
 */
export function rowOfBlock(
  block: StreamBlock,
  prior: StreamCheckpoint | undefined
): StreamCheckpoint {
  return {
    identity: block.id,
    ordinal: block.ordinal,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    promptHead: promptHead(block.prompt),
    compacted: block.compacted,
    file: block.file,
    ...(block.compaction !== undefined ? { compaction: block.compaction } : {}),
    ...(block.previousSessionId !== undefined
      ? { previousSessionId: block.previousSessionId }
      : {}),
    ...(prior?.rolledBack === true ? { rolledBack: true as const } : {}),
    ...(prior?.marks !== undefined ? { marks: prior.marks } : {})
  }
}

/** First non-empty line, capped where the light index caps it (120). */
function promptHead(prompt: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  if (line.length === 0) return '(empty prompt)'
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** Blocks folded into the cache by identity — new object, never a mutation. */
function cached(
  current: Readonly<Record<string, StreamBlock>>,
  blocks: readonly StreamBlock[]
): Record<string, StreamBlock> {
  if (blocks.length === 0) return current as Record<string, StreamBlock>
  const next = { ...current }
  for (const block of blocks) next[block.id] = block
  return next
}

/**
 * Apply one rollback note to the rows it covers.
 *
 * MARKED, NEVER REMOVED. Panel C ②: a /rewind makes the file shorter, and the
 * old reader answered by rebuilding its cache — so the cut checkpoints simply
 * stopped existing and anything anchored to them (a pin, a Sous title, a
 * fork) pointed at nothing. Appending the note instead keeps every position
 * addressable and lets the rail say what happened to it.
 */
function markRolledBack(
  rows: readonly StreamCheckpoint[],
  fromOrdinal: number
): readonly StreamCheckpoint[] {
  let changed = false
  const next = rows.map((row) => {
    if (row.ordinal < fromOrdinal || row.rolledBack === true) return row
    changed = true
    return { ...row, rolledBack: true as const }
  })
  return changed ? next : rows
}

/** Patch exactly one row's marks. `null` clears them. */
function patchMark(
  rows: readonly StreamCheckpoint[],
  identity: string,
  mark: StreamMarks | null
): readonly StreamCheckpoint[] {
  let changed = false
  const next = rows.map((row) => {
    if (row.identity !== identity) return row
    changed = true
    if (mark === null) {
      const { marks: _dropped, ...rest } = row
      return rest
    }
    return { ...row, marks: mark }
  })
  return changed ? next : rows
}

/** The tail's row folded into the index: patched in place, or appended. */
function withTail(state: StreamState, tail: StreamTail): StreamState {
  const block = tail.block
  if (block === null) {
    return { ...state, tail, total: tail.total }
  }
  const prior = state.index.find((row) => row.identity === block.id)
  const row = rowOfBlock(block, prior)
  return {
    ...state,
    tail,
    total: tail.total,
    blocks: cached(state.blocks, [block]),
    index: mergeIndex(state.index, [row])
  }
}

/**
 * ONE transition. Every case returns a NEW state object; nothing here reads
 * the clock, the network or the DOM, so the whole contract — open, live tail,
 * mark, rollback, page back — is testable as arithmetic.
 */
export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.kind) {
    case 'reset':
      return initialStreamState(action.terminalId)

    case 'open': {
      const { open } = action
      const seeded: StreamState = {
        ...state,
        index: ordered(open.index),
        blocks: cached({}, open.tail?.block ? [open.tail.block] : []),
        tail: open.tail,
        total: open.tail?.total ?? open.index[open.index.length - 1]?.ordinal ?? 0,
        backwardsCursor: open.backwardsCursor,
        anomalies: { ...open.anomalies },
        rolledBack: [...open.rolledBack],
        source: open.source,
        opened: true,
        error: null
      }
      // The server's own rows already carry `rolledBack`; replaying the notes
      // over them costs nothing and covers a server that reports the note but
      // has not yet flagged the rows (a page written before the note landed).
      return open.rolledBack.reduce(
        (acc, note) => ({ ...acc, index: markRolledBack(acc.index, note.fromOrdinal) }),
        seeded
      )
    }

    case 'index':
      return {
        ...state,
        index: mergeIndex(state.index, action.checkpoints),
        ...(action.backwardsCursor !== undefined
          ? { backwardsCursor: action.backwardsCursor }
          : {}),
        ...(action.total !== undefined ? { total: action.total } : {}),
        opened: true
      }

    case 'tail':
      return withTail(state, action.tail)

    case 'mark':
      return { ...state, index: patchMark(state.index, action.identity, action.mark) }

    case 'rollback': {
      const known = state.rolledBack.some((note) => note.fromOrdinal === action.fromOrdinal)
      return {
        ...state,
        index: markRolledBack(state.index, action.fromOrdinal),
        rolledBack: known
          ? [...state.rolledBack]
          : [...state.rolledBack, { fromOrdinal: action.fromOrdinal, at: action.at }]
      }
    }

    case 'blocks': {
      const marks = action.marks ?? {}
      const rows = action.blocks.map((block) => {
        const prior = state.index.find((row) => row.identity === block.id)
        const row = rowOfBlock(block, prior)
        const mark = marks[block.id]
        return mark === undefined ? row : { ...row, marks: mark }
      })
      return {
        ...state,
        blocks: cached(state.blocks, action.blocks),
        index: mergeIndex(state.index, rows),
        ...(action.total !== undefined ? { total: action.total } : {})
      }
    }

    case 'live':
      return { ...state, live: action.live }

    case 'error':
      return { ...state, error: action.error }

    default:
      return state
  }
}

/** How many lines the stream could not read, over every anomaly kind. */
export function anomalyCount(anomalies: Readonly<Record<string, number>>): number {
  return Object.values(anomalies).reduce((sum, count) => sum + count, 0)
}

/**
 * Where a block window must START so that it CONTAINS `identity`.
 *
 * The routes' cursors are EXCLUSIVE and name one END of a window, so the
 * anchor is the row before where the window should begin — which is the only
 * way to be certain the requested identity lands inside it. `before=<identity>`
 * would return the page that stops just short of the very block the caller
 * asked to read, which is how a jump lands on a placeholder that never fills.
 *
 * Null means "start at the stream's oldest": either the window reaches the
 * beginning, or the identity is one this client has not indexed yet, and the
 * honest first page is the oldest one rather than a guess.
 */
export function anchorFor(
  index: readonly StreamCheckpoint[],
  identity: string,
  limit: number
): string | null {
  const at = index.findIndex((row) => row.identity === identity)
  if (at < 0) return null
  const start = Math.max(0, at - Math.floor(limit / 2))
  return start > 0 ? index[start - 1].identity : null
}

/**
 * The marks a patch implies, applied over what is already on the row.
 *
 * A `null` CLEARS the field it names — a title withdrawn and a title never
 * written are different facts, and the ledger makes the same distinction for
 * the same reason (marks.ts). Used for the optimistic patch: a title that
 * appears half a second after you typed it reads as a write that failed.
 */
export function patchToMark(index: readonly StreamCheckpoint[], patch: MarkPatch): StreamMarks {
  const prior = index.find((row) => row.identity === patch.identity)?.marks ?? {}
  const { identity: _identity, ...fields } = patch
  const merged: Record<string, unknown> = { ...prior }
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged as StreamMarks
}
