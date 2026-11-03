import { useId, useLayoutEffect, useRef, useState } from 'react'
import { InkAvatar } from '../zoom/InkAvatar'
import { pickerRows } from './item-user'
import type { FaceAgent } from './PromptFace'
import { agentKey, newKey, revealAt, whoFilter, whoKeys, whoStart, whoStep } from './who-keys'

/**
 * WHO THE WORDS GO TO (owner design, 2026-11-03): a tap on the chip opens
 * this. Whoever waits on you, then the most recently active, then a new agent
 * on each harness. One row of faces above the box on a phone (it fits over
 * the keyboard), a list above the chip on a wide screen — the same markup,
 * laid out by prompt-face.css.
 *
 * THE KEYS (cut "Who-picker keyboard & filter", 2026-11-04): on a wide screen
 * a 'Send to…' field heads the list and takes the focus as it opens; typing
 * filters agents and harnesses by name, ↑ ↓ move, ⏎ picks, Esc closes, and
 * the focus goes back to the box's words (GlobalPrompt.tsx). The field is the
 * combobox, the rows one listbox (aria-activedescendant): the groups are
 * labelled, no heading stands inside it. A phone's strip has no field: it
 * scrolls the one in the box into view.
 *
 * A pick stands until the zoom's next deliberate move (prompt-target.ts ·
 * boxTargetId `picked`); a new agent's pick lets go of the agent in the box.
 */

export type WhoRow = FaceAgent & { lastActivityAt: number }

export interface WhoPickerProps {
  /** Every agent of the crew, as its face draws it. */
  rows: readonly WhoRow[]
  /** Who leads the recent row: the users of the items in view (item-user.ts · usersInView). */
  first: readonly string[]
  /** Its title: "recent", or "used it" in a browser's or a note's full view. */
  recentTitle: string
  harnesses: readonly string[]
  current: { id: string | null; harness: string }
  onAgent: (id: string) => void
  onNew: (harness: string) => void
  /** Esc in the field: the box takes the focus back. */
  onClose: () => void
}

const SUB: Record<string, string> = { waiting: 'needs you', working: 'working', done: 'done', offline: 'offline', idle: '' }

interface RowProps {
  id: string
  agent: FaceAgent | null
  harness: string
  current: boolean
  active: boolean
  sub: string
  onPoint: () => void
  onPick: () => void
}

function Row({ id, agent, harness, current, active, sub, onPoint, onPick }: RowProps): React.JSX.Element {
  return (
    <button
      type="button"
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-current={current ? 'true' : undefined}
      className={`pf-who-row${agent ? '' : ' new'}${agent?.status === 'waiting' ? ' waiting' : ''}`}
      // Keep the focus where it is (the field, or the box's caret on a phone).
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onPoint}
      onClick={onPick}
    >
      <span className="pf-who-face">
        <InkAvatar id={agent?.id ?? `new:${harness}`} preset={agent?.preset ?? harness} orch={agent?.orch ?? false} status={agent?.status ?? 'idle'} weight="regular" />
      </span>
      <b>{agent ? agent.name : harness}</b>
      <small>{sub}</small>
      {active && (
        <kbd className="pf-who-enter" aria-hidden="true">
          ⏎
        </kbd>
      )}
    </button>
  )
}

/** Scroll `scroller` the least it takes to show `el`, both ways (the list scrolls down, the strip across). */
function reveal(scroller: HTMLElement | null, el: HTMLElement | null): void {
  if (!scroller || !el) return
  const box = scroller.getBoundingClientRect()
  const at = el.getBoundingClientRect()
  // A strip's face clears the rounded end by a little.
  const pad = 6
  scroller.scrollTop = revealAt(scroller.scrollTop, scroller.clientHeight, at.top - box.top + scroller.scrollTop, at.height)
  scroller.scrollLeft = revealAt(scroller.scrollLeft, scroller.clientWidth, at.left - box.left + scroller.scrollLeft - pad, at.width + 2 * pad)
}

export function WhoPicker({ rows, first, recentTitle, harnesses, current, onAgent, onNew, onClose }: WhoPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pointed, setPointed] = useState<string | null>(null)
  const lists = pickerRows(rows, { current: current.id, first, query })
  const news = whoFilter(harnesses, query, (h) => h)
  const keys = whoKeys(lists, news)
  const currentKey = current.id !== null ? agentKey(current.id) : newKey(current.harness)
  const active = pointed !== null && keys.includes(pointed) ? pointed : whoStart(keys, currentKey)
  const uid = useId()
  const idOf = (key: string): string => `${uid}o${keys.indexOf(key)}`
  const listId = `${uid}list`
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const picks = new Map<string, () => void>()
  /** The field shows on a wide screen only (prompt-face.css): its absence is the phone's strip. */
  const typing = (): boolean => (field.current?.getClientRects().length ?? 0) > 0

  // Open: the focus into the list (its field); a phone keeps the box's caret.
  useLayoutEffect(() => {
    if (typing()) field.current?.focus({ preventScroll: true })
  }, [])
  // The row ⏎ points at stays in view; on a phone, the one in the box.
  useLayoutEffect(() => {
    const key = typing() ? active : currentKey
    if (key && keys.includes(key)) reveal(list.current, document.getElementById(idOf(key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentKey, keys.join('\u0000')])

  const agentRow = (a: FaceAgent, sub: string): React.ReactNode => {
    const key = agentKey(a.id)
    picks.set(key, () => onAgent(a.id))
    return <Row key={key} id={idOf(key)} agent={a} harness={a.preset} current={key === currentKey} active={key === active} sub={sub} onPoint={() => key !== active && setPointed(key)} onPick={() => onAgent(a.id)} />
  }
  const newRow = (h: string): React.ReactNode => {
    const key = newKey(h)
    picks.set(key, () => onNew(h))
    return <Row key={key} id={idOf(key)} agent={null} harness={h} current={key === currentKey} active={key === active} sub="" onPoint={() => key !== active && setPointed(key)} onPick={() => onNew(h)} />
  }
  const group = (title: string, body: React.ReactNode): React.ReactNode => (
    <div className="pf-who-group" role="group" aria-label={title}>
      <div className="pf-who-title" aria-hidden="true">
        {title}
      </div>
      <div className="pf-who-rows">{body}</div>
    </div>
  )

  return (
    <div className="pf-who">
      <input
        ref={field}
        className="pf-who-find"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? idOf(active) : undefined}
        aria-label="Send to"
        placeholder="Send to…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setPointed(null)
        }}
        onKeyDown={(e) => {
          // The zoom's keys and the box's form are not the picker's.
          e.stopPropagation()
          // An IME's keys are its own: Enter and Esc settle the words being composed.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setPointed(whoStep(keys, active, e.key === 'ArrowDown' ? 1 : -1))
          } else if (e.key === 'Enter') {
            // Never the form's submit: ⏎ here picks, it sends nothing.
            e.preventDefault()
            if (active) picks.get(active)?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <div ref={list} className="pf-who-list" id={listId} role="listbox" aria-label="Send to">
        {lists.waiting.length > 0 && group('needs you', lists.waiting.map((a) => agentRow(a, SUB.waiting)))}
        {lists.recent.length > 0 && group(query.trim() ? 'agents' : recentTitle, lists.recent.map((a) => agentRow(a, SUB[a.status] ?? '')))}
        {news.length > 0 && group('new agent', news.map(newRow))}
      </div>
      {keys.length === 0 && (
        <p className="pf-who-none" role="status">
          Nobody called “{query.trim()}”
        </p>
      )}
    </div>
  )
}
