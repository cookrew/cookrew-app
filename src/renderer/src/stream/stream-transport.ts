// WHAT CARRIES THE STREAM, AND WHY THERE ARE TWO (one-stream T3).
//
// The design says ONE hook over ONE API, and that is true of the CONTRACT —
// but the companion and the desktop have never shared a wire. A phone talks
// HTTP to the mobile server; the desktop renderer has no origin at all and
// talks IPC through the preload bridge. Nothing above this file knows which:
// useStream is written against this interface, and the reducer never learns
// that a transport exists.
//
// This is the one place where "the renderer reads one stream" is made true
// for both surfaces rather than only the one whose routes were built first.

import type {
  LiveState,
  MarkPatch,
  StreamBlockPage,
  StreamCursor,
  StreamIndexPage,
  StreamMarks,
  StreamOpen,
  StreamTail
} from './stream-types'

/** What a live subscription pushes back. All four are optional to act on;
 *  none of them may throw into the transport. */
export interface StreamLiveHandlers {
  onTail: (tail: StreamTail) => void
  onMark: (identity: string, mark: StreamMarks | null) => void
  onRollback: (fromOrdinal: number, at: number) => void
  onState: (live: LiveState) => void
  onError: (message: string) => void
}

export interface StreamTransport {
  /** The whole first paint: newest index page, the tail, the cursors. */
  open: (terminalId: string) => Promise<StreamOpen>
  /** A page of the index, backwards or forwards from an identity. */
  index: (terminalId: string, cursor: StreamCursor) => Promise<StreamIndexPage>
  /** A window of FULL blocks, by identity — never the whole chain. */
  blocks: (terminalId: string, cursor: StreamCursor) => Promise<StreamBlockPage>
  /**
   * The tail ALONE, for a surface that wants the last turn and nothing else:
   * the card preview and the board's rows. It is a separate read rather than
   * an open because a board of twenty idle agents must not pull twenty
   * index pages to draw twenty one-line previews.
   */
  tail: (terminalId: string) => Promise<StreamTail | null>
  /** The only write in this design. */
  mark: (terminalId: string, patch: MarkPatch) => Promise<void>
  /** Subscribe; the returned function unsubscribes and must be idempotent. */
  live: (terminalId: string, handlers: StreamLiveHandlers) => () => void
}

/**
 * A transport that answers nothing, for a surface with neither wire — the
 * demo bundle, and any build whose bridge predates the stream.
 *
 * IT REFUSES OUT LOUD. An empty rail that looks like "this agent has no
 * history" is the exact confusion that made 400 checkpoints look destroyed,
 * so the hook surfaces this as an error and a live state of 'off' rather than
 * as a card with nothing on it.
 */
export function createAbsentStreamTransport(reason: string): StreamTransport {
  const refuse = (): Promise<never> => Promise.reject(new Error(reason))
  return {
    open: refuse,
    index: refuse,
    blocks: refuse,
    tail: refuse,
    mark: refuse,
    live: (_terminalId, handlers) => {
      handlers.onState('off')
      return () => undefined
    }
  }
}
