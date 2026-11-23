import { useCallback, useEffect, useRef, useState } from 'react'
import { apiPath } from '../api-base'
import { openWebSocket } from '../rtc-plane'
import { useDataPlaneRoute } from '../use-data-plane'
import { VIEWPORT_MIN, streamPath } from '../browser-stream'
import { socketLine, type StreamLine, type StreamLineHandlers } from '../stream-line'
import { actMsg, framesOffMsg, readMsg, type MirrorAct } from './mirror-message'
import { MIRROR_IDLE, nextMirror, type MirrorEvent, type MirrorState } from './mirror-state'

/**
 * THE PAGE AS DATA, ON ITS OWN LINE (mirror/useMirrorPage.ts).
 *
 * The mirror opens the same cast line a picture would — same route, same
 * credential, same plane — but uses it differently: it never offers a viewport
 * (the page keeps its size for whoever watches its screen), it asks the
 * computer to hold its frames, and it reads the page as blocks it draws itself.
 *
 * A page the computer cannot read, a line that drops, an answer that never
 * comes: each is a sentence in `state`, never a quiet switch to the stream.
 */

/** No answer to a read or an act within this long: the view says so. A press can wait on a page load. */
export const MIRROR_ANSWER_MS = 20_000

export interface MirrorPageView {
  readonly state: MirrorState
  /** One verb on one element; `value` only for `type`. */
  readonly act: (ref: number, act: MirrorAct, value?: string) => void
  /** Read the page again (it changes on its own; nothing pushes it here). */
  readonly reload: () => void
  /** Open the line again after it failed. */
  readonly retry: () => void
}

export function useMirrorPage(browserId: string, open: boolean): MirrorPageView {
  const [state, setState] = useState<MirrorState>(MIRROR_IDLE)
  const [attempt, setAttempt] = useState(0)
  const planeRoute = useDataPlaneRoute()
  const lineRef = useRef<StreamLine | null>(null)
  const answerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const step = useCallback((event: MirrorEvent): void => setState((prev) => nextMirror(prev, event)), [])

  const clearAnswerTimer = useCallback((): void => {
    if (answerTimerRef.current !== null) clearTimeout(answerTimerRef.current)
    answerTimerRef.current = null
  }, [])

  const ask = useCallback(
    (message: object): void => {
      const line = lineRef.current
      if (!line?.isOpen()) return
      line.send(message)
      step({ type: 'asked' })
      clearAnswerTimer()
      answerTimerRef.current = setTimeout(() => step({ type: 'lost', why: 'The computer did not answer.' }), MIRROR_ANSWER_MS)
    },
    [step, clearAnswerTimer]
  )

  useEffect(() => {
    if (!open) {
      step({ type: 'close' })
      return
    }
    let disposed = false
    step({ type: 'open' })
    const handlers: StreamLineHandlers = {
      onOpen: () => undefined,
      onMessage: (msg) => {
        if (disposed) return
        if (msg.kind === 'ready') {
          // The computer has this viewer now: hold the frames, then read.
          line.send(framesOffMsg())
          ask(readMsg())
          return
        }
        if (msg.kind === 'mirror') {
          clearAnswerTimer()
          step({ type: 'message', message: msg.message })
          return
        }
        if (msg.kind === 'error') {
          clearAnswerTimer()
          step({ type: 'lost', why: 'The computer could not open this page.' })
          return
        }
        // A frame that left before the hold arrived is passed over, and said so
        // on a paced line, or that line would wait on a picture nobody draws.
        if (msg.kind === 'frame' || msg.kind === 'same') line.receipt(msg.seq)
      },
      onClose: () => {
        if (disposed) return
        clearAnswerTimer()
        step({ type: 'lost', why: 'The line to the computer closed.' })
      }
    }
    let line: StreamLine
    try {
      line = socketLine(openWebSocket(apiPath(streamPath(browserId, VIEWPORT_MIN, VIEWPORT_MIN, null))), handlers)
    } catch {
      step({ type: 'lost', why: 'The line to the computer could not be opened.' })
      return
    }
    lineRef.current = line
    return () => {
      disposed = true
      clearAnswerTimer()
      line.close()
      if (lineRef.current === line) lineRef.current = null
    }
    // planeRoute: a move onto another plane opens the line there, as the picture's does.
  }, [browserId, open, attempt, planeRoute, step, ask, clearAnswerTimer])

  const act = useCallback((ref: number, verb: MirrorAct, value?: string): void => ask(actMsg(ref, verb, value)), [ask])
  const reload = useCallback((): void => ask(readMsg()), [ask])
  const retry = useCallback((): void => setAttempt((n) => n + 1), [])

  return { state, act, reload, retry }
}
