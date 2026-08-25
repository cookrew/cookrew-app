// The state behind the translate button: which checkpoint is showing in which
// language, whether Sous is still working, and what to say when it could not.

import { useCallback, useRef, useState } from 'react'
import { cookrew } from './api'
import type { CheckpointTranslation } from './TranscriptView'
import { TRANSLATE_FAILURE_TEXT, type TranslateFailure } from '../../shared/translate'

export interface TranslationState {
  /** The body being shown translated, or null for "as written". */
  showing: CheckpointTranslation | null
  /** Language code of `showing`, for ticking the menu. */
  language: string | null
  /** True while Sous is working — the button is busy, not broken. */
  working: boolean
  /** Reader-facing sentence for the last failure, cleared by the next attempt. */
  error: string | null
}

const IDLE: TranslationState = { showing: null, language: null, working: false, error: null }

export interface TranslationControls extends TranslationState {
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
   * Only the newest request may write the result. Two clicks in a row — or a
   * click on a second language while the first is still running — would
   * otherwise race, and the slower one would win and label the body with the
   * language nobody asked for last.
   */
  const runId = useRef(0)

  const clear = useCallback(() => {
    runId.current += 1
    setState(IDLE)
  }, [])

  const translate = useCallback(
    (index: number, body: { prompt: string; reply: string }, language: string) => {
      const run = ++runId.current
      setState({ showing: null, language, working: true, error: null })
      void (async () => {
        try {
          // The prompt and the reply go separately: they are different kinds of
          // text (verbatim human words vs the agent's markdown) and one failing
          // should not throw away the other.
          const [prompt, reply] = await Promise.all([
            translatePart(body.prompt, language),
            translatePart(body.reply, language)
          ])
          if (run !== runId.current) return
          if (prompt.failure !== null && reply.failure !== null) {
            setState({
              showing: null,
              language,
              working: false,
              error: TRANSLATE_FAILURE_TEXT[prompt.failure]
            })
            return
          }
          setState({
            showing: { index, prompt: prompt.text, reply: reply.text },
            language,
            working: false,
            // A half-success is reported as one: the part that came back is
            // shown, and the part that did not is named rather than quietly
            // left in the original language for the reader to puzzle over.
            error: partialNote(prompt.failure, reply.failure)
          })
        } catch (error) {
          if (run !== runId.current) return
          console.error('translate failed:', error)
          setState({
            showing: null,
            language,
            working: false,
            error: TRANSLATE_FAILURE_TEXT.unreachable
          })
        }
      })()
    },
    []
  )

  const note = useCallback((message: string) => {
    runId.current += 1
    setState({ showing: null, language: null, working: false, error: message })
  }, [])

  return { ...state, translate, clear, note }
}

interface PartResult {
  text: string | null
  failure: TranslateFailure | null
}

/** Empty text is nothing to translate — not a failure and not a request. */
async function translatePart(text: string, language: string): Promise<PartResult> {
  if (text.trim().length === 0) return { text: null, failure: null }
  const result = await cookrew().translateCheckpoint(text, language)
  return result.ok ? { text: result.text, failure: null } : { text: null, failure: result.failure }
}

function partialNote(
  prompt: TranslateFailure | null,
  reply: TranslateFailure | null
): string | null {
  if (prompt === null && reply === null) return null
  const which = prompt !== null ? 'The prompt' : 'The reply'
  return `${which} did not translate — ${TRANSLATE_FAILURE_TEXT[(prompt ?? reply) as TranslateFailure]}`
}
