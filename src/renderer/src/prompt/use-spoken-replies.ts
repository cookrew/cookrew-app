import { useEffect, useRef, useState } from 'react'
import type { TerminalActivity } from '../../../shared/turn'

/**
 * 🔊 SPOKEN REPLIES: while on, the box's agent's reply is read aloud when its
 * turn completes. One switch for the box (it outlived VoiceBar.tsx, where it
 * was the agent's alone): it can be turned before a new agent exists, and the
 * agent the box carries next is the one heard.
 */

const KEY = 'cookrew-speak-replies'
/** What is read of a long reply: its start, never the whole essay. */
const GIST_CHARS = 300

export interface Heard {
  readonly id: string | null
  readonly phase: TerminalActivity['phase'] | undefined
}

/**
 * Whether this render reads a reply: the SAME agent's turn has just landed on
 * 'replied'. An agent the box has just come to, already replied, is not read.
 */
export function shouldSpeak(was: Heard, now: Heard, reply: string | null | undefined, on: boolean): boolean {
  return on && now.id !== null && was.id === now.id && now.phase === 'replied' && was.phase !== 'replied' && Boolean(reply)
}

/** The words read: whitespace folded, the first GIST_CHARS of them. */
export function gistOf(text: string): string {
  return (text || 'done').replace(/\s+/g, ' ').trim().slice(0, GIST_CHARS)
}

function speak(text: string): void {
  if (typeof speechSynthesis === 'undefined') return
  speechSynthesis.cancel()
  speechSynthesis.speak(new SpeechSynthesisUtterance(gistOf(text)))
}

function savedOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function useSpokenReplies(agentId: string | null, activity: TerminalActivity | undefined): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(savedOn)
  const was = useRef<Heard>({ id: agentId, phase: activity?.phase })
  useEffect(() => {
    const now: Heard = { id: agentId, phase: activity?.phase }
    if (shouldSpeak(was.current, now, activity?.reply, on)) speak(activity?.reply ?? '')
    was.current = now
  }, [agentId, activity?.phase, activity?.reply, on])

  const toggle = (): void => {
    const next = !on
    setOn(next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      // private mode: on for this session only
    }
    if (next) speak('Spoken replies on')
    else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
  }
  return { on, toggle }
}
