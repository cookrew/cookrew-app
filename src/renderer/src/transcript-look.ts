import { useEffect, useState } from 'react'

/**
 * TWO VIEWS OF AN AGENT (owner, 2026-10-31: "chat is chat; live is the raw
 * herdr terminal").
 *
 *   chat  — the conversation only: your prompts on the right, the agent's
 *           tool calls and replies in bubbles on the left beside its face,
 *           and a status strip while it works. You talk to it from the dock.
 *   live  — the agent's own herdr terminal, filling the card, as it runs.
 *
 * The terminal is never unmounted and never resized by the switch: in chat it
 * lies under the conversation, unseen, in exactly the box it fills in live
 * (transcript-paper.css), so the agent's pane keeps its size either way. One
 * choice for every card, kept across reloads.
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
