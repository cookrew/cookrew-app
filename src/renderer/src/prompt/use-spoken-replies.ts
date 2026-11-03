import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TerminalActivity } from '../../../shared/turn'
import { isPrimed, isReading, onReading, primeVoice, readAloud, stopReading } from './reply-voice'

/**
 * 🔊 SPOKEN REPLIES: while on, the box's agent's final reply is read aloud
 * when its turn completes, all of it as sentences (shared/speakable.ts), in
 * the Doubao voice where the Mac has one (prompt/reply-voice.ts). One switch
 * for the box (it outlived VoiceBar.tsx, where it was the agent's alone): it
 * can be turned before a new agent exists, and the agent the box carries next
 * is the one heard.
 *
 * A tap while a reply is being read stops that reading and leaves spoken
 * replies on; a tap while quiet turns them off.
 */

const KEY = 'cookrew-speak-replies'

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

function savedOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export interface SpokenReplies {
  readonly on: boolean
  /** A reply is being read now. */
  readonly reading: boolean
  readonly toggle: () => void
}

export function useSpokenReplies(agentId: string | null, activity: TerminalActivity | undefined): SpokenReplies {
  const [on, setOn] = useState(savedOn)
  const reading = useSyncExternalStore(onReading, isReading, () => false)
  const was = useRef<Heard>({ id: agentId, phase: activity?.phase })
  // Spoken replies restored on after a reload were never primed by a tap:
  // the owner's next tap anywhere (the send that asks for the reply) does it.
  useEffect(() => {
    if (!on || isPrimed() || typeof document === 'undefined') return
    const prime = (): void => {
      primeVoice()
      if (isPrimed()) document.removeEventListener('pointerdown', prime, true)
    }
    document.addEventListener('pointerdown', prime, true)
    return () => document.removeEventListener('pointerdown', prime, true)
  }, [on])
  useEffect(() => {
    const now: Heard = { id: agentId, phase: activity?.phase }
    if (shouldSpeak(was.current, now, activity?.reply, on)) void readAloud(activity?.reply ?? '')
    was.current = now
  }, [agentId, activity?.phase, activity?.reply, on])

  const toggle = (): void => {
    if (on && reading) {
      stopReading()
      return
    }
    const next = !on
    setOn(next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      // private mode: on for this session only
    }
    if (next) {
      primeVoice()
      void readAloud('Spoken replies on')
    } else {
      stopReading()
    }
  }
  return { on, reading, toggle }
}
