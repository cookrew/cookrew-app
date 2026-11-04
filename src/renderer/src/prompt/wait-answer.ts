import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { useActivity } from '../activity-thumb-store'
import { cookrew } from '../api'
import { draftKey, getDraft, setDraft } from './prompt-draft'
import { choiceId, choiceKeys, choiceSig, ESC, hasWordsRow, keyChoice, staysOpen, type MenuAct, type WaitChoice } from '../../../shared/wait-choice'


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
/** How long the words for an answer that did not land stand. */
const FAILED_MS = 4000
/** Those words: the screen had moved on, or the answer was stopped on its way. */
export const ANSWER_FAILED = {
  moved: 'the menu moved on · nothing sent',
  refused: 'that answer did not go through · try again'
} as const

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

/** The menu a waiting agent shows, read off its whole screen in the main process; null unless it waits on one. */
export function useWaitChoice(agentId: string | null): WaitChoice | null {
  const activity = useActivity(agentId ?? '')
  return agentId && activity?.phase === 'waiting' ? (activity.waitChoice ?? null) : null
}

/**
 * What a key does to the menu on show: a row's key answers it; Esc is Esc to
 * a TUI's menu, but nothing to a line-reading confirm (an Esc byte there
 * would sit in its line and spoil the next answer). Null: not this box's key.
 */
export function keyAction(view: WaitView | null, key: string): { index: number; keys: string } | null {
  if (!view || view.sent !== null) return null
  if (key === 'Escape') return view.choice.kind === 'menu' ? { index: view.choice.escIndex ?? -1, keys: ESC } : null
  // On the row to type in, a digit is a word of the answer.
  if (view.choice.cursor !== null && view.choice.options[view.choice.cursor]?.role === 'type') return null
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
  /** Another question of a question tool. */
  readonly step: (dir: -1 | 1) => void
  /** The menu has a row to type in: the box's words are its answer. */
  readonly wordsRow: boolean
  /** Words from the box into that row (the draft is the caller's to clear; a refusal puts them back). */
  readonly sendWords: (words: string) => void
  /**
   * A key from the tray, while a menu stands. It goes the menu's way, not the
   * terminal's: raw bytes are held back from a dispatched turn, whose menu is
   * the one thing still to be answered.
   */
  readonly trayKey: ((seq: string) => void) | null
  /** Why the last answer did not land, in words; null when it did. */
  readonly failed: string | null
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

  // The answer goes as "this menu, this row": the main process checks it
  // against the screen and works the keys out there (main/menu-answer.ts).
  const [failed, setFailed] = useState<string | null>(null)
  const failedTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(failedTimer.current), [])
  const deliver = (act: MenuAct, choice: WaitChoice, onRefused?: () => void): void => {
    if (!agentId) return
    const refused = (reason: keyof typeof ANSWER_FAILED): void => {
      waitAnswers.forget(agentId)
      setFailed(ANSWER_FAILED[reason])
      window.clearTimeout(failedTimer.current)
      failedTimer.current = window.setTimeout(() => setFailed(null), FAILED_MS)
      onRefused?.()
    }
    cookrew()
      .answerMenu(agentId, { menu: choiceId(choice), act })
      .then((result) => {
        if (!result.ok) refused(result.reason)
      }, () => refused('refused'))
  }
  const send = (index: number, choice: WaitChoice, act: MenuAct): void => {
    if (!agentId) return
    deliver(act, choice)
    // A tick, a move to the row to type in: the menu stays, showing what changed.
    if (staysOpen(choice.options[index])) return
    waitAnswers.set(agentId, { sig: choiceSig(choice), index, choice, at: Date.now() })
  }
  const typeRow = (choice: WaitChoice, index: number): boolean => choice.options[index]?.role === 'type'
  const answerRow = (index: number, byKey = false): void => {
    if (!view || view.sent !== null) return
    if (choiceKeys(view.choice, index) === null) return
    send(index, view.choice, { kind: 'row', index })
    // A tick from the keyboard stays on its row: the next may be ticked too.
    if (index === view.choice.escIndex || (byKey && !staysOpen(view.choice.options[index])) || typeRow(view.choice, index)) onType?.()
  }
  const key = (pressed: string): boolean => {
    const act = keyAction(view, pressed)
    if (!act || !view) return false
    send(act.index, view.choice, act.keys === ESC ? { kind: 'esc' } : { kind: 'row', index: act.index })
    if (act.index === view.choice.escIndex || typeRow(view.choice, act.index)) onType?.()
    return true
  }
  const step = (dir: -1 | 1): void => {
    if (!view || !agentId) return
    deliver({ kind: 'step', dir }, view.choice)
    waitAnswers.forget(agentId)
  }
  const sendWords = (words: string): void => {
    if (!live || !agentId) return
    deliver({ kind: 'words', text: words }, live, () => {
      // Not sent: the words go back in the box, unless more are there.
      if (getDraft(draftKey(agentId)) === '') setDraft(draftKey(agentId), words)
    })
  }
  const trayKey = live ? (seq: string): void => deliver({ kind: 'key', seq }, live) : null
  return { view, menu: live !== null, answer: answerRow, key, step, wordsRow: hasWordsRow(live), sendWords, trayKey, failed }
}

