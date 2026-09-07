// THE ONE HOOK (design: docs/site/one-stream-2026-09-07.html, phase T3).
//
//   "Renderer: listTurns + listTrace*, mergeCheckpointRows, checkpoint-sync,
//    use-latest-checkpoints  →  One hook useStream(terminalId): index for the
//    rail, a block window for the drawer, the live tail for both. No join, no
//    clamping, no phantom rows."
//
// WHAT THIS REPLACES, PRECISELY. The rail fetched a stored ledger AND a trace
// index and joined them by a key that could drift; the drawer fetched a third
// listing by a numbering that a compaction restarted; the card preview polled
// a fourth route. Four reads, three coordinate systems, one join in the
// farthest-away place. Here there is ONE read, ONE coordinate (the stream
// ordinal), and the only join — marks onto positions — already happened in
// the reader.
//
// NOTHING IS MERGED FROM TWO SOURCES ANYWHERE IN THIS FILE. Every dispatch
// below carries data from exactly one answer; the reducer folds them by
// identity. If a future reader needs a second source, it belongs in the
// reader, not here — that is the mistake this phase is undoing.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { isRemoteMode } from '../api'
import { createBridgeStreamTransport } from './stream-bridge'
import { createHttpStreamTransport } from './stream-http'
import {
  anchorFor,
  anomalyCount,
  initialStreamState,
  patchToMark,
  streamReducer,
  type StreamState
} from './stream-reducer'
import {
  anomalyLine,
  markersOfIndex,
  rowsOfIndex,
  type CheckpointRow,
  type TraceMarkerRow
} from './stream-rows'
import type { StreamTransport } from './stream-transport'
import type {
  LiveState,
  MarkPatch,
  RollbackNote,
  StreamBlock,
  StreamBlockPage,
  StreamCheckpoint,
  StreamTail
} from './stream-types'

/** Blocks per drawer page. The pager's own window, unchanged. */
export const BLOCK_PAGE = 20
/** Rows per backwards index page. The rail asks for history a screenful of
 *  checkpoints at a time, never the whole chain. */
export const INDEX_PAGE = 100

export interface StreamHandle {
  /** The rail's positions, ascending by ordinal. */
  index: readonly StreamCheckpoint[]
  /** The same rows, projected for the rail's geometry. */
  rows: CheckpointRow[]
  /** Compaction and rewind boundaries, derived from the rows themselves. */
  markers: TraceMarkerRow[]
  /** The open exchange. */
  tail: StreamTail | null
  /** Length of the WHOLE stream, which is not the number of rows loaded. */
  total: number
  /** Blocks this client has seen, by identity — the drawer's cache. */
  blocks: Readonly<Record<string, StreamBlock>>
  /** A window of full blocks containing `identity`. */
  blocksAround: (identity: string, limit?: number) => Promise<StreamBlockPage>
  /** The window that FOLLOWS `identity`; null starts at the stream's oldest. */
  blocksAfter: (identity: string | null, limit?: number) => Promise<StreamBlockPage>
  /** One more page of index rows, older than what is loaded. */
  pageBack: () => Promise<void>
  /** True once there is nothing older to page to. */
  atOldest: boolean
  markSeen: (identity: string) => void
  setTitle: (identity: string, title: string) => void
  /** With a version, pin it here; without one, clear the pin. */
  pin: (identity: string, version?: number) => void
  live: LiveState
  anomalies: Readonly<Record<string, number>>
  /** The quiet footer line, or null when every line was read. */
  anomalyNote: string | null
  rolledBack: readonly RollbackNote[]
  /** The last failure, so a rail can say why rather than show nothing. */
  error: string | null
  /** False until the first answer lands — "not yet" is not "no history". */
  opened: boolean
}

/**
 * Which wire this surface has. Phone → HTTP; desktop → the preload bridge.
 * Injectable so the hook's behaviour is testable without either.
 */
export function pickStreamTransport(): StreamTransport {
  return isRemoteMode() ? createHttpStreamTransport() : createBridgeStreamTransport()
}

export function useStream(
  terminalId: string,
  options: { transport?: StreamTransport } = {}
): StreamHandle {
  const [state, dispatch] = useReducer(streamReducer, terminalId, initialStreamState)
  const override = options.transport
  const transport = useMemo(
    () => override ?? pickStreamTransport(),
    // A transport is chosen once per card. Re-choosing on every render would
    // rebuild the EventSource on every keystroke elsewhere in the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [override, terminalId]
  )
  // The reducer's state, readable from callbacks that must not re-create
  // themselves on every row change (blocksAround is passed to the pager).
  const stateRef = useRef<StreamState>(state)
  stateRef.current = state

  useEffect(() => {
    let alive = true
    dispatch({ kind: 'reset', terminalId })
    void transport
      .open(terminalId)
      .then((open) => {
        if (alive) dispatch({ kind: 'open', open })
      })
      .catch((error: unknown) => {
        // A rail that throws is a rail that renders nothing. The failure is
        // carried as data so the surface can SAY it — an empty rail that
        // looks like "no history" is the confusion this design is unpicking.
        if (alive) dispatch({ kind: 'error', error: messageOf(error) })
      })
    const stop = transport.live(terminalId, {
      onTail: (tail) => {
        if (alive) dispatch({ kind: 'tail', tail })
      },
      onMark: (identity, mark) => {
        if (alive) dispatch({ kind: 'mark', identity, mark })
      },
      onRollback: (fromOrdinal, at) => {
        if (alive) dispatch({ kind: 'rollback', fromOrdinal, at })
      },
      onState: (live) => {
        if (alive) dispatch({ kind: 'live', live })
      },
      onError: (message) => {
        if (alive) dispatch({ kind: 'error', error: message })
      }
    })
    return () => {
      alive = false
      stop()
    }
  }, [terminalId, transport])

  const pageBack = useCallback(async (): Promise<void> => {
    const cursor = stateRef.current.backwardsCursor
    if (cursor === null) return
    try {
      const page = await transport.index(terminalId, { before: cursor, limit: INDEX_PAGE })
      dispatch({
        kind: 'index',
        checkpoints: page.checkpoints,
        backwardsCursor: page.backwardsCursor ?? null,
        ...(page.total !== undefined ? { total: page.total } : {})
      })
    } catch (error) {
      dispatch({ kind: 'error', error: messageOf(error) })
    }
  }, [terminalId, transport])

  const fetchBlocks = useCallback(
    async (after: string | null, limit: number): Promise<StreamBlockPage> => {
      try {
        const page = await transport.blocks(
          terminalId,
          after === null ? { limit } : { after, limit }
        )
        dispatch({
          kind: 'blocks',
          blocks: page.blocks,
          ...(page.marks !== undefined ? { marks: page.marks } : {}),
          ...(page.total !== undefined ? { total: page.total } : {})
        })
        return page
      } catch (error) {
        dispatch({ kind: 'error', error: messageOf(error) })
        return { blocks: [] }
      }
    },
    [terminalId, transport]
  )

  /** A window of full blocks CONTAINING `identity` — see anchorFor. */
  const blocksAround = useCallback(
    (identity: string, limit = BLOCK_PAGE): Promise<StreamBlockPage> =>
      fetchBlocks(anchorFor(stateRef.current.index, identity, limit), limit),
    [fetchBlocks]
  )

  const blocksAfter = useCallback(
    (identity: string | null, limit = BLOCK_PAGE): Promise<StreamBlockPage> =>
      fetchBlocks(identity, limit),
    [fetchBlocks]
  )

  const write = useCallback(
    (patch: MarkPatch): void => {
      // OPTIMISTIC, because a title that appears half a second after you typed
      // it reads as a write that failed. The server's own `mark` event is what
      // settles it; a refusal comes back as an error and the next event
      // corrects the row.
      dispatch({
        kind: 'mark',
        identity: patch.identity,
        mark: patchToMark(stateRef.current.index, patch)
      })
      void transport.mark(terminalId, patch).catch((error: unknown) => {
        dispatch({ kind: 'error', error: messageOf(error) })
      })
    },
    [terminalId, transport]
  )

  const markSeen = useCallback(
    (identity: string) => write({ identity, seenAt: Date.now() }),
    [write]
  )
  const setTitle = useCallback(
    (identity: string, title: string) => write({ identity, title }),
    [write]
  )
  // A bare pin(identity) CLEARS: the mark's `pin` is a version number (the
  // VersionPinRecord this checkpoint was cut for), so there is no sensible
  // value to invent for a call that names none.
  const pin = useCallback(
    (identity: string, version?: number) => write({ identity, pin: version ?? null }),
    [write]
  )

  const rows = useMemo(() => rowsOfIndex(state.index), [state.index])
  const markers = useMemo(
    () => markersOfIndex(state.index, state.rolledBack),
    [state.index, state.rolledBack]
  )

  return {
    index: state.index,
    rows,
    markers,
    tail: state.tail,
    total: state.total,
    blocks: state.blocks,
    blocksAround,
    blocksAfter,
    pageBack,
    atOldest: state.backwardsCursor === null,
    markSeen,
    setTitle,
    pin,
    live: state.live,
    anomalies: state.anomalies,
    anomalyNote: anomalyLine(anomalyCount(state.anomalies)),
    rolledBack: state.rolledBack,
    error: state.error,
    opened: state.opened
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
