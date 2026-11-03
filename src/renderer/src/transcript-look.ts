import { createContext, useEffect, useState } from 'react'

/**
 * THREE VIEWS OF AN AGENT, TWO SOURCES (owner, 2026-10-31: render the live
 * transcript from the chat's data, so switching changes the drawing, not the
 * source).
 *
 *   chat  — the conversation record as a chat: your prompts on the right,
 *           the agent's tool calls and replies in bubbles beside its face.
 *   log   — THE SAME RECORD, drawn the way the agent's terminal draws it:
 *           monospace, ❯ prompts, ⏺ tool calls and replies, ⎿ results. Same
 *           rows as the chat (TranscriptRow), restyled by one class, so it
 *           cannot show a reprint, a wrong width or a half-painted screen —
 *           the screen is not where it comes from.
 *   live  — the agent's own herdr terminal, filling the card: for what the
 *           record does not hold (a permission prompt, a choice, a TUI).
 *
 * chat and log are the RECORD views (isRecordLook): the terminal lies under
 * them unseen, in exactly the box it fills in live (transcript-paper.css), so
 * no switch resizes the agent's pane. One choice for every card, kept.
 */

export type TranscriptLook = 'chat' | 'log' | 'live'

export const TRANSCRIPT_LOOK_KEY = 'cookrew.transcript-look'

export const transcriptLookOf = (raw: string | null | undefined): TranscriptLook =>
  raw === 'live' || raw === 'log' ? raw : 'chat'

/** The look the rows are drawn in (TranscriptRow.tsx): the chat folds an agent's steps, the log prints them all. */
export const TranscriptLookContext = createContext<TranscriptLook>('chat')

/** chat and log draw the conversation record; live is the raw terminal. */
export const isRecordLook = (look: TranscriptLook): boolean => look !== 'live'

/** The toggle's order: chat → log → live → chat. */
export const nextLook = (look: TranscriptLook): TranscriptLook => (look === 'chat' ? 'log' : look === 'log' ? 'live' : 'chat')

export const LOOK_LABEL: Record<TranscriptLook, string> = { chat: 'CHAT', log: 'LOG', live: 'LIVE' }

export const LOOK_TITLE: Record<TranscriptLook, string> = {
  chat: "Chat: the conversation with the agent — tap for the log, the same conversation as the terminal draws it",
  log: "Log: the conversation as the agent's terminal draws it, from the record — tap for live, the agent's own terminal",
  live: "Live: the agent's own terminal — tap for chat"
}

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
