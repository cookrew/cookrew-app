import { useCallback, useEffect, useRef, useState } from 'react'
import type { TurnRecord } from '../../../shared/turn'
import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { gotoCursor } from '../checkpoint-sync'

/**
 * Turn paging state for an agent card: `viewing === null` shows the live
 * turn; otherwise a past TurnRecord is displayed. History is fetched lazily
 * on first page-back and refreshed whenever the terminal completes another
 * turn (turnCount changes).
 */
export interface TurnPaging {
  /** Past turn on display, or null for the live view. */
  viewing: TurnRecord | null
  /** 1-based position of the viewed turn within the fetched history. */
  position: number | null
  count: number
  /** Fetched checkpoint records (eager mode only; null otherwise). */
  records: TurnRecord[] | null
  back: () => void
  forward: () => void
  live: () => void
  /** Jump straight to a checkpoint by its TurnRecord.index (timeline press). */
  goto: (turnIndex: number) => void
  /** Fork from the viewed turn (or the latest turn when live). */
  fork: () => void
  forking: boolean
}

/**
 * Paging state for an agent's checkpoints. Cards use the lazy default (records
 * fetch only on first page-back); the timeline passes `{ eager: true }` so the
 * full checkpoint list is available up front to render diamonds and jump.
 */
export function useTurnPaging(
  terminalId: string,
  turnCount: number,
  opts?: { eager?: boolean }
): TurnPaging {
  const eager = opts?.eager ?? false
  const [records, setRecords] = useState<TurnRecord[] | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [forking, setForking] = useState(false)
  const fetching = useRef(false)

  // Eager: keep the list loaded + fresh as checkpoints land. Lazy: refresh
  // only while paging, and drop the cache on live so the next ◀ re-fetches.
  useEffect(() => {
    if (eager) {
      if (turnCount === 0) {
        setRecords(null)
        return
      }
      void cookrew().listTurns(terminalId).then(setRecords)
      return
    }
    if (cursor === null) {
      setRecords(null)
      return
    }
    void cookrew().listTurns(terminalId).then(setRecords)
  }, [terminalId, turnCount, cursor !== null, eager])

  const back = useCallback(() => {
    if (records === null) {
      if (fetching.current) return
      fetching.current = true
      void cookrew()
        .listTurns(terminalId)
        .then((list) => {
          fetching.current = false
          if (list.length === 0) return
          setRecords(list)
          // First ◀ from live lands on the latest completed turn.
          setCursor(list.length - 1)
        })
      return
    }
    setCursor((c) => Math.max(0, (c ?? records.length) - 1))
  }, [records, terminalId])

  const forward = useCallback(() => {
    if (records === null || cursor === null) return
    // Paging past the newest turn returns to the live view.
    setCursor(cursor + 1 >= records.length ? null : cursor + 1)
  }, [records, cursor])

  const live = useCallback(() => setCursor(null), [])

  const goto = useCallback(
    (turnIndex: number) => {
      if (records === null) return
      const cursor = gotoCursor(records, turnIndex)
      if (cursor !== null) setCursor(cursor)
    },
    [records]
  )

  const fork = useCallback(() => {
    if (forking) return
    const index = cursor !== null && records ? records[cursor]?.index : undefined
    setForking(true)
    void cookrew()
      .forkTerminal(terminalId, index)
      .catch((error) => console.error('Fork failed:', error))
      .finally(() => setForking(false))
  }, [terminalId, records, cursor, forking])

  const viewing = cursor !== null && records ? (records[cursor] ?? null) : null
  return {
    viewing,
    position: cursor === null ? null : cursor + 1,
    count: records?.length ?? turnCount,
    records,
    back,
    forward,
    live,
    goto,
    fork,
    forking
  }
}

/**
 * Slim pager row at the bottom of agent cards: ◀ turn i/N ▶, LIVE, and the
 * fork action. Clicks must not bubble — the card body's click zooms the
 * viewport to the node.
 */
export function TurnPagerBar({ paging }: { paging: TurnPaging }): React.JSX.Element {
  const stop = (e: React.MouseEvent): void => e.stopPropagation()
  const atOldest = paging.position !== null && paging.position <= 1
  return (
    <div className="vi-pager nodrag nowheel" onClick={stop}>
      <button
        className="vi-pager-btn"
        title="Previous checkpoint"
        disabled={paging.count === 0 || atOldest}
        onClick={paging.back}
      >
        <CrIcon name="prev" />
      </button>
      <span className="vi-pager-label">
        {paging.viewing
          ? `CHECKPOINT ${paging.viewing.index}`
          : `LIVE · ${paging.count} CHECKPOINT${paging.count === 1 ? '' : 'S'}`}
      </span>
      <button
        className="vi-pager-btn"
        title="Next checkpoint"
        disabled={paging.viewing === null}
        onClick={paging.forward}
      >
        <CrIcon name="next" />
      </button>
      {paging.viewing !== null && (
        <button className="vi-pager-btn wide" title="Back to live view" onClick={paging.live}>
          LIVE
        </button>
      )}
      <button
        className="vi-pager-btn wide fork"
        title={
          paging.viewing
            ? `Fork a new agent from checkpoint ${paging.viewing.index}`
            : 'Fork a new agent from the latest checkpoint'
        }
        disabled={paging.count === 0 || paging.forking}
        onClick={paging.fork}
      >
        <CrIcon name="fork" /> {paging.forking ? '…' : 'FORK'}
      </button>
    </div>
  )
}

/** Body of a card while paged onto a past turn: prompt + recorded reply. */
export function PastTurnView({ record }: { record: TurnRecord }): React.JSX.Element {
  return (
    <>
      <div className="vi-you">
        <span className="vi-you-label">You:</span> {record.prompt || '(empty prompt)'}
      </div>
      <div className="vi-msg vi-past-reply">{record.reply || '(no visible output this turn)'}</div>
      <div className="vi-past-meta">
        checkpoint {record.index}
        {record.title ? ` · ${record.title}` : ''} · {timeLabel(record.endedAt)} ·{' '}
        {durationLabel(record.endedAt - record.startedAt)}
      </div>
    </>
  )
}

function timeLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function durationLabel(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000))
  return secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
}
