import { useEffect, useState } from 'react'

/**
 * TWO WAYS TO READ AN AGENT'S TRANSCRIPT (owner, 2026-10-31).
 *
 *   chat  — each exchange as a chat: your prompt on the right, the agent's
 *           tool calls and reply in a bubble on the left beside its face
 *           (transcript-paper.css, under .look-chat).
 *   live  — the transcript as it was before the chat: heading, prompt, tool
 *           calls, reply, one after another at the full width.
 *
 * Both read the SAME rows (TranscriptRow.tsx renders the chat wrappers, and
 * the live look dissolves them with display: contents), so switching is one
 * class on the card, never a re-render of a transcript that can run to
 * thousands of exchanges. One choice for every card, kept across reloads.
 */

export type TranscriptLook = 'chat' | 'live'

export const TRANSCRIPT_LOOK_KEY = 'cookrew.transcript-look'

export const transcriptLookOf = (raw: string | null | undefined): TranscriptLook => (raw === 'live' ? 'live' : 'chat')

const listeners = new Set<(look: TranscriptLook) => void>()
let current: TranscriptLook | null = null

function read(): TranscriptLook {
  if (current !== null) return current
  try {
    current = transcriptLookOf(window.localStorage.getItem(TRANSCRIPT_LOOK_KEY))
  } catch {
    current = 'chat'
  }
  return current
}

export function setTranscriptLook(look: TranscriptLook): void {
  current = look
  try {
    window.localStorage.setItem(TRANSCRIPT_LOOK_KEY, look)
  } catch {
    // Storage blocked: the choice lasts this session.
  }
  for (const listener of listeners) listener(look)
}

/** The look every open card follows; switching it on one switches it on all. */
export function useTranscriptLook(): [TranscriptLook, (look: TranscriptLook) => void] {
  const [look, setLook] = useState<TranscriptLook>(read)
  useEffect(() => {
    listeners.add(setLook)
    setLook(read())
    return () => {
      listeners.delete(setLook)
    }
  }, [])
  return [look, setTranscriptLook]
}
