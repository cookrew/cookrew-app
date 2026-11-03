import { useId } from 'react'
import type { WaitChoice } from '../../../shared/wait-choice'
import { InkAvatar } from '../zoom/InkAvatar'
import type { WaitAnswering, WaitView } from './wait-answer'
import './wait-choices.css'

/**
 * THE WAIT CHOICE BOX (owner task, 2026-11-04; cut
 * docs/avatar-send-tasks/g-choice). While the box's agent waits on a menu its
 * TUI is showing (shared/wait-choice.ts), the menu stands over the open box,
 * in any view: the question in serif with the agent's face and NEEDS YOU in
 * red, one row per option with its key, the TUI's cursor row outlined, in a
 * red frame. A tap sends that option's keys through the agent's live line
 * (wait-answer.ts), never into the draft; 1–9 or y/n with the box empty do the
 * same, Esc is Esc. The sent row fills with the primary for a beat, then the
 * box shuts as the agent goes on. The Esc row ("No, and tell it what to do
 * differently") sends Esc and puts the caret in the box.
 *
 * The rows (WaitRows) also stand, smaller, in the bar group's card for a
 * waiting agent (zoom/BarCards.tsx): answered without going anywhere.
 *
 * A group named by its question; rows are buttons whose names carry their
 * key; they come before the box in the focus order.
 */

export interface WaitFace {
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly orch: boolean
}

/** "1–3" or "y / n": the keys the footer offers. */
export function keysWord(choice: WaitChoice): string {
  if (choice.kind === 'yn') return 'y / n'
  const n = choice.options.length
  return n === 1 ? '1' : `1–${Math.min(n, 9)}`
}

/** A row's accessible name: its key, its words, and what the Esc row does. */
export function rowLabel(choice: WaitChoice, index: number): string {
  const option = choice.options[index]
  const esc = index === choice.escIndex ? ' (Esc, then type)' : ''
  return `${option.key}: ${option.label}${esc}`
}

export function WaitRows({ view, onAnswer, small = false }: {
  view: WaitView
  onAnswer: (index: number, byKey: boolean) => void
  small?: boolean
}): React.JSX.Element {
  const { choice, sent } = view
  const id = useId()
  return (
    <div className={`wc-rows${choice.kind === 'yn' ? ' yn' : ''}${small ? ' small' : ''}`}>
      {choice.options.map((option, index) => {
        const filled = sent === index
        return (
          <button
            key={`${index}:${option.label}`}
            type="button"
            className={`wc-row${index === choice.cursor ? ' cursor' : ''}${filled ? ' sent' : ''}${sent !== null && !filled ? ' spent' : ''}`}
            aria-label={rowLabel(choice, index)}
            aria-current={index === choice.cursor ? 'true' : undefined}
            aria-describedby={option.detail && !small ? `${id}-${index}` : undefined}
            disabled={sent !== null}
            // detail 0: Enter or Space on the row, not a pointer.
            onClick={(e) => onAnswer(index, e.detail === 0)}
          >
            <kbd aria-hidden="true">{filled ? '✓' : option.key}</kbd>
            <span className="wc-words">
              <span className="wc-label">{option.label}</span>
              {option.detail && !small && <small id={`${id}-${index}`}>{option.detail}</small>}
            </span>
            {index === choice.escIndex && <em aria-hidden="true">esc · then type</em>}
          </button>
        )
      })}
    </div>
  )
}

/** The footer's two halves: how to answer, then what is going on. */
export function footWords(view: WaitView): [string, string] {
  // A confirm reads a line: Esc means nothing to it, so none is offered.
  if (view.sent === null) return [`tap · or ${keysWord(view.choice)}${view.choice.kind === 'menu' ? ' · esc cancels' : ''}`, 'its own menu, mirrored']
  const option = view.choice.options[view.sent]
  return [option ? `sent ${option.key} · the agent goes on` : 'esc sent · the agent goes on', 'closes as it works']
}

/** The box over the prompt: the face, the question and the rows in a red frame. */
export function WaitChoices({ face, wait }: { face: WaitFace; wait: WaitAnswering }): React.JSX.Element | null {
  const qid = useId()
  const view = wait.view
  if (!view) return null
  const { choice } = view
  const [how, what] = footWords(view)
  return (
    <div
      className={`wc-box${view.sent !== null ? ' answered' : ''}`}
      role="group"
      aria-labelledby={qid}
      // A row's key (or Esc) while a row has the focus: the same as the box's.
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (!wait.key(e.key)) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="wc-head">
        <span className="wc-face" aria-hidden="true">
          <InkAvatar id={face.id} preset={face.preset} orch={face.orch} status="waiting" weight="regular" />
        </span>
        <div className="wc-ask">
          <span className="wc-who">
            {face.name} <b>needs you</b>
          </span>
          <p className="wc-q" id={qid}>
            {choice.question}
          </p>
          <span className="wc-sub">{choice.sub ? `${choice.sub} · the agent waits` : 'the agent waits'}</span>
        </div>
      </div>
      <WaitRows view={view} onAnswer={wait.answer} />
      <div className="wc-foot" role="status">
        <span>{how}</span>
        <span>{what}</span>
      </div>
    </div>
  )
}
