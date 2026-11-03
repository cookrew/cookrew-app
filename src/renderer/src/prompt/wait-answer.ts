import { useEffect, useMemo, useReducer, useSyncExternalStore } from 'react'
import { useActivity } from '../activity-thumb-store'
import { cookrew } from '../api'
import { choiceKeys, choiceSig, ESC, keyChoice, parseWaitChoice, type WaitChoice } from '../../../shared/wait-choice'


/**
 * AN ANSWER TO A WAITING AGENT'S MENU (owner task, 2026-11-04; cut
 * docs/avatar-send-tasks/g-choice). The box over the prompt and the bar
 * group's card show the same menu (shared/wait-choice.ts), and either one
 * answers it: the row's keys go into the agent's own terminal, never into the
 * draft. The sent row fills for a beat (FILL_MS); then the menu stays shut
 * while the agent moves on. If the very same question is still up RETRY_MS
 * later, the keys did not take, and it shows again to be answered.
 *
 * One record per agent, in this module: answered from the card, the box over
 * the prompt knows it too.
 */

export const FILL_MS = 600
export const RETRY_MS = 5000

export interface Answer {
  readonly sig: string
  /** The row sent; -1 for a bare Esc with no Esc row. */
  readonly index: number
  /** The menu as it stood, drawn while its row fills (the agent may have moved on already). */
  readonly choice: WaitChoice
  readonly at: number
}

export interface WaitView {
  readonly choice: WaitChoice
  /** The row just sent, filling; null while the menu waits on a pick. */
  readonly sent: number | null
}

/** What the box shows: the sent row filling, nothing while the agent takes it, else the live menu. */
export function answerView(live: WaitChoice | null, answer: Answer | null, now: number): WaitView | null {
  if (answer && now - answer.at < FILL_MS) return { choice: answer.choice, sent: answer.index }
  if (live && answer && choiceSig(live) === answer.sig && now - answer.at < RETRY_MS) return null
  return live ? { choice: live, sent: null } : null
}

let answers = new Map<string, Answer>()
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of listeners) listener()
}

export const waitAnswers = {
  get: (agentId: string): Answer | null => answers.get(agentId) ?? null,
  set(agentId: string, answer: Answer): void {
    answers = new Map(answers).set(agentId, answer)
    emit()
  },
  forget(agentId: string): void {
    if (!answers.has(agentId)) return
    const next = new Map(answers)
    next.delete(agentId)
    answers = next
    emit()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  resetForTests(): void {
    answers = new Map()
  }
}

/** The menu a waiting agent shows, read off its activity; null unless it waits on one. */
export function useWaitChoice(agentId: string | null): WaitChoice | null {
  const activity = useActivity(agentId ?? '')
  // A mirrorless activity has no lines to read: herdr says only that it waits.
  const lines = agentId && activity?.phase === 'waiting' && !activity.mirrorless ? activity.lines : null
  return useMemo(() => (lines ? parseWaitChoice(lines) : null), [lines])
}

/**
 * What a key does to the menu on show: a row's key answers it; Esc is Esc to
 * a TUI's menu, but nothing to a line-reading confirm (an Esc byte there
 * would sit in its line and spoil the next answer). Null: not this box's key.
 */
export function keyAction(view: WaitView | null, key: string): { index: number; keys: string } | null {
  if (!view || view.sent !== null) return null
  if (key === 'Escape') return view.choice.kind === 'menu' ? { index: view.choice.escIndex ?? -1, keys: ESC } : null
  const index = keyChoice(view.choice, key)
  if (index === null) return null
  const keys = choiceKeys(view.choice, index)
  return keys === null ? null : { index, keys }
}

export interface WaitAnswering {
  readonly view: WaitView | null
  /** The agent waits on a menu this reads (answered or not): its question is no free one. */
  readonly menu: boolean
  /**
   * Send a row's keys. The Esc row hands over to typing (`onType`); so does an
   * answer from the keyboard (`byKey`), whose row is about to go away.
   */
  readonly answer: (index: number, byKey?: boolean) => void
  /** A key pressed with the box empty: a row's key, or Esc. True when it answered. */
  readonly key: (key: string) => boolean
}

export function useWaitAnswer(agentId: string | null, onType?: () => void): WaitAnswering {
  const live = useWaitChoice(agentId)
  const answer = useSyncExternalStore(
    waitAnswers.subscribe,
    () => (agentId ? waitAnswers.get(agentId) : null),
    () => null
  )
  const view = answerView(live, answer, Date.now())
  // Wake at the fill's end and at the retry: the view is a function of time.
  const sentAt = answer?.at ?? null
  const [, wake] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (sentAt === null) return
    const timers = [FILL_MS, RETRY_MS].map((ms) => window.setTimeout(wake, Math.max(0, sentAt + ms - Date.now())))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [sentAt])
  // The agent moved on: the record is done with.
  useEffect(() => {
    if (agentId && answer && !live && Date.now() - answer.at >= FILL_MS) waitAnswers.forget(agentId)
  })

  const send = (index: number, keys: string, choice: WaitChoice): void => {
    if (!agentId) return
    cookrew().ptyInput(agentId, keys)
    waitAnswers.set(agentId, { sig: choiceSig(choice), index, choice, at: Date.now() })
  }
  const answerRow = (index: number, byKey = false): void => {
    if (!view || view.sent !== null) return
    const keys = choiceKeys(view.choice, index)
    if (keys === null) return
    send(index, keys, view.choice)
    if (index === view.choice.escIndex || byKey) onType?.()
  }
  const key = (pressed: string): boolean => {
    const act = keyAction(view, pressed)
    if (!act || !view) return false
    send(act.index, act.keys, view.choice)
    if (act.index === view.choice.escIndex) onType?.()
    return true
  }
  return { view, menu: live !== null, answer: answerRow, key }
}

