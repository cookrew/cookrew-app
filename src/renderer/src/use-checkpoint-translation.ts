// The state behind the translate button: which checkpoint is showing in which
// language, how far along Sous is, and what to say when it could not.
//
// WHY THE PIECES ARE CUT HERE AND NOT IN MAIN.
//
// They used to be cut behind the IPC call: one invoke went in, one finished
// body came back, and everything in between was silence. A local 1.5b–3b model
// runs about 19 seconds per 3000 characters and cannot be parallelised (Ollama
// serialises: measured 1.2x across four concurrent requests), so a long
// checkpoint is minutes of a card that says "Translating…" and does nothing
// observable. That is indistinguishable from broken, and it was reported as
// broken.
//
// Cutting them here makes each piece its own round trip, which buys three
// things that no amount of work behind the call could: a count that advances,
// text that appears as it arrives, and a STOP that actually stops — the loop
// simply does not ask for the next piece.

import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from './api'
import type { CheckpointTranslation } from './TranscriptView'
import {
  REMOTE_CHUNK_CHARS,
  TRANSLATE_CHUNK_CHARS,
  TRANSLATE_FAILURE_TEXT,
  splitForTranslation,
  type TranslateFailure
} from '../../shared/translate'
import { looksUntranslated } from '../../shared/translate-check'

export interface TranslationProgress {
  done: number
  total: number
}

export interface TranslationState {
  /** The body being shown translated, or null for "as written". */
  showing: CheckpointTranslation | null
  /** Language code of `showing`, for ticking the menu. */
  language: string | null
  /** True while Sous is working — the button is busy, not broken. */
  working: boolean
  /** How many pieces are done, so a long body shows movement. */
  progress: TranslationProgress | null
  /** Reader-facing sentence for the last failure, cleared by the next attempt. */
  error: string | null
}

const IDLE: TranslationState = {
  showing: null,
  language: null,
  working: false,
  progress: null,
  error: null
}

export interface TranslationControls extends TranslationState {
  /** Host the text is sent to, or null when translation happens on this machine. */
  host: string | null
  translate: (index: number, body: { prompt: string; reply: string }, language: string) => void
  /** Back to the words as written. */
  clear: () => void
  /**
   * Report a reason the caller found before Sous was ever asked — a checkpoint
   * whose text has not loaded, say. It exists so that case is a sentence rather
   * than a click that does nothing.
   */
  note: (message: string) => void
}

export function useCheckpointTranslation(): TranslationControls {
  const [state, setState] = useState<TranslationState>(IDLE)
  /**
   * Host of the remote translator, or null when Sous is the local Ollama.
   *
   * The reader is told this because it is the one thing about the feature they
   * cannot see: local and remote produce the same-looking Japanese, and only
   * one of them sent the transcript to somebody else's server. It also sets the
   * piece size — a hosted model swallows a whole body, a local one must not be
   * asked to.
   */
  const [host, setHost] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void cookrew()
      .translateHost()
      .then((h) => {
        if (alive) setHost(h)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  /**
   * Only the newest request may write. Two clicks in a row — or a click on a
   * second language while the first is still running — would otherwise race,
   * and the slower one would win and label the body with the language nobody
   * asked for last. It is also what STOP bumps, which is why STOP ends the loop
   * rather than merely hiding it.
   */
  const runId = useRef(0)

  const clear = useCallback(() => {
    runId.current += 1
    setState(IDLE)
  }, [])

  const note = useCallback((message: string) => {
    runId.current += 1
    setState({ ...IDLE, error: message })
  }, [])

  const translate = useCallback(
    (index: number, body: { prompt: string; reply: string }, language: string) => {
      const run = ++runId.current
      const limit = host === null ? TRANSLATE_CHUNK_CHARS : REMOTE_CHUNK_CHARS
      const prompt = splitForTranslation(body.prompt, limit)
      const reply = splitForTranslation(body.reply, limit)
      const total = prompt.length + reply.length
      if (total === 0) {
        setState({ ...IDLE, error: 'There is nothing to translate in this checkpoint.' })
        return
      }

      setState({
        showing: null,
        language,
        working: true,
        progress: { done: 0, total },
        error: null
      })

      void (async () => {
        const out = { prompt: [] as string[], reply: [] as string[] }
        let done = 0
        /**
         * Pieces the model handed back untranslated. Magpie measured roughly
         * one long body in four dying on this, and killing eight pieces of
         * work because the sixth echoed is a bad trade — an echo is a fact
         * about ONE piece, not about the server. Keep the original for it,
         * carry on, and say how many at the end.
         */
        let echoed = 0
        // Prompt first: it is short and it is the line at the top of the block,
        // so the reader sees the translation start where they are looking.
        const work = [
          ...prompt.map((text) => ({ text, part: 'prompt' as const })),
          ...reply.map((text) => ({ text, part: 'reply' as const }))
        ]

        for (const piece of work) {
          if (run !== runId.current) return // stopped, or superseded
          let failure: TranslateFailure | null = null
          /**
           * The transport's own words, when the transport is what failed.
           *
           * A throw here is OUR side refusing — a route the served client
           * cannot call, a stale credential — and it says nothing about Sous.
           * Reporting it as 'unreachable' told people to go and check whether
           * Ollama was running while Ollama was running and answering; the
           * real reason ("this route is not workspace-scoped yet") was sitting
           * in the error nobody showed.
           */
          let detail: string | null = null
          try {
            const res = await cookrew().translateCheckpoint(piece.text, language)
            if (run !== runId.current) return
            if (!res.ok) failure = res.failure
            else if (looksUntranslated(piece.text, res.text, language)) failure = 'unusable-output'
            else out[piece.part].push(res.text)
          } catch (error) {
            console.error('translate failed:', error)
            failure = 'request-failed'
            detail = error instanceof Error ? error.message : String(error)
          }

          if (failure === 'unusable-output') {
            // The original, verbatim, so the body stays whole and the words
            // are still the agent's own rather than a guess at them.
            out[piece.part].push(piece.text)
            echoed += 1
            done += 1
            setState({
              showing: partial(index, out, true),
              language,
              working: done < total,
              progress: { done, total },
              error: null
            })
            continue
          }

          if (failure !== null) {
            // Stop where it stopped and SAY where. The alternative — carry on
            // and splice the untranslated original in — produces a body that
            // is half one language with no seam marked, which reads as a bad
            // translation rather than a stalled one.
            setState({
              showing: partial(index, out, done > 0),
              language,
              working: false,
              progress: { done, total },
              error:
                done === 0
                  ? reasonText(failure, detail)
                  : `Stopped after ${done} of ${total} pieces — ${reasonText(failure, detail)} The rest is unchanged.`
            })
            return
          }

          done += 1
          // Show what has arrived. On a long body this is the difference
          // between watching it fill in and watching nothing.
          setState({
            showing: partial(index, out, true),
            language,
            working: done < total,
            progress: { done, total },
            // Reported at the end rather than on every piece, so the count is
            // final and not a number that jitters while you read it.
            error:
              done < total || echoed === 0
                ? null
                : `${echoed} of ${total} ${echoed === 1 ? 'piece' : 'pieces'} came back untranslated and ${echoed === 1 ? 'is' : 'are'} shown as written.`
          })
        }
      })()
    },
    [host]
  )

  return { ...state, host, translate, clear, note }
}

/** The reason, carrying the transport's own message when there is one. */
function reasonText(failure: TranslateFailure, detail: string | null): string {
  const base = TRANSLATE_FAILURE_TEXT[failure]
  return detail === null || detail.trim().length === 0 ? base : `${base} (${detail.trim()})`
}

/** What has arrived so far, or null before anything has. */
function partial(
  index: number,
  out: { prompt: string[]; reply: string[] },
  any: boolean
): CheckpointTranslation | null {
  if (!any) return null
  return {
    index,
    prompt: out.prompt.length > 0 ? out.prompt.join('') : null,
    reply: out.reply.length > 0 ? out.reply.join('') : null
  }
}
