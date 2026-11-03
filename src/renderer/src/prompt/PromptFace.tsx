import { useEffect, useRef } from 'react'
import { InkAvatar } from '../zoom/InkAvatar'
import type { InkStatus } from '../zoom/ink-status'
import './prompt-face.css'

/**
 * THE FACE THAT IS THE SEND KEY (owner, 2026-11-04; design
 * docs/avatar-send-design-2026-11-04.html). The prompt's target drawn as its
 * real ink face (InkAvatar: its harness mark, its ensō, its live state), or,
 * with nobody in the box, a dashed ring round the harness a new agent would
 * run.
 *
 *   folded  on the zoom's bar (or alone in a corner): a small badge says what
 *           a tap leads to, → for an agent, ＋ for a new one; a seal dot says
 *           words wait in its draft. A tap opens the box.
 *   empty   in the open box with no words: a tap chooses who (the picker).
 *   ready   in the open box with words: filled with the theme's primary, the
 *           ink turned to the colour on it; a tap sends.
 *
 * A HOLD (450 ms, about a platform long-press; a finger or a pen, never a
 * mouse, whose Mac has ⌘-hold) talks to it: the ear opens while the finger stays, and the
 * words land in its draft on release, never sent (owner design, 2026-11-03).
 */

export interface FaceAgent {
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly orch: boolean
  readonly status: InkStatus
}

export type FaceMode = 'folded' | 'empty' | 'ready'

const HOLD_MS = 450

export interface PromptFaceProps {
  agent: FaceAgent | null
  /** The harness a new agent runs: its mark, when nobody is in the box. */
  harness: string
  mode: FaceMode
  /** Words wait in this face's draft. */
  draft?: boolean
  /** It opens the who-picker when tapped empty: whether that picker is open. */
  expanded?: boolean
  /** Keep the caret where it is when pressed (the box's own send key). */
  keepFocus?: boolean
  listening?: boolean
  type?: 'button' | 'submit'
  disabled?: boolean
  label: string
  title?: string
  className?: string
  onTap: (e: React.MouseEvent<HTMLButtonElement>) => void
  /** A hold began (the ear opens) and ended (it closes). Absent: no hold. */
  onHold?: () => void
  onHoldEnd?: () => void
}

const Plus = (): React.JSX.Element => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" />
  </svg>
)

const Arrow = (): React.JSX.Element => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
)

export function PromptFace({
  agent,
  harness,
  mode,
  draft = false,
  expanded,
  keepFocus = false,
  listening = false,
  type = 'button',
  disabled = false,
  label,
  title,
  className,
  onTap,
  onHold,
  onHoldEnd
}: PromptFaceProps): React.JSX.Element {
  const timer = useRef<number | null>(null)
  const held = useRef(false)
  /** The click that follows a hold's release is the hold's, not a tap. */
  const swallow = useRef(false)
  const clear = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  // A face going away takes its pending hold with it.
  useEffect(() => clear, [])
  const endHold = (released: boolean): void => {
    clear()
    // Only a hold the finger lifted from ends in a click to drop.
    swallow.current = released && held.current
    if (!held.current) return
    held.current = false
    onHoldEnd?.()
  }
  const classes = [
    'pf-face',
    agent ? 'pf-agent' : 'pf-new',
    `pf-${mode}`,
    draft && mode !== 'ready' ? 'pf-has-draft' : '',
    listening ? 'pf-listening' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      aria-haspopup={expanded === undefined ? undefined : 'listbox'}
      aria-expanded={expanded}
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      onPointerDown={(e) => {
        swallow.current = false
        if (!onHold || e.button !== 0 || e.pointerType === 'mouse') return
        held.current = false
        // The release must come back here even if the finger slides off.
        e.currentTarget.setPointerCapture?.(e.pointerId)
        timer.current = window.setTimeout(() => {
          timer.current = null
          held.current = true
          onHold()
        }, HOLD_MS)
      }}
      onPointerUp={() => endHold(true)}
      onPointerCancel={() => endHold(false)}
      // A long press must not open the phone's context menu over the face.
      onContextMenu={(e) => {
        if (onHold) e.preventDefault()
      }}
      onClick={(e) => {
        // A keyboard's click (Enter, Space) is never a hold's.
        if (swallow.current && e.detail > 0) {
          swallow.current = false
          e.preventDefault()
          return
        }
        onTap(e)
      }}
    >
      <span className="pf-disc">
        <InkAvatar
          id={agent?.id ?? `new:${harness}`}
          preset={agent?.preset ?? harness}
          orch={agent?.orch ?? false}
          status={agent?.status ?? 'idle'}
          weight="regular"
        />
      </span>
      {mode === 'folded' && <span className="pf-verb">{agent ? <Arrow /> : <Plus />}</span>}
      {draft && mode !== 'ready' && <span className="pf-dot" aria-hidden="true" />}
    </button>
  )
}
