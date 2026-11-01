import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasNode } from '../../../shared/model'
import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { VoiceBar } from '../VoiceBar'
import { makeAgent } from '../zoom/make-card'
import { zoomStore } from '../zoom/zoom-store'
import { nameFromPrompt } from './agent-name'
import { lastHarness, rememberHarness } from './harness-pref'
import { endLine, lineTextFor, submitLine, typeLine, useLiveLine } from './live-line'
import { draftKey, getDraft, useDraft } from './prompt-draft'
import { mentionTarget, promptTargetOf } from './prompt-target'
import { sendToAgent } from './send'
import './global-prompt.css'

/**
 * THE GLOBAL PROMPT (owner, 2026-11-01): one prompt box at the foot of the
 * app, right after the dock's buttons.
 *
 *   @agent   in an agent's full view, or with its card open, the box talks to
 *            that agent. Its draft IS the agent's own input line (live-line.ts):
 *            typed there as it is written, so LIVE shows it, and words typed
 *            in LIVE show here; Enter submits it. The card's reply box is the
 *            same draft (prompt-draft.ts). × (or Backspace on an empty box)
 *            lets go of the agent.
 *   nobody   the prompt makes a new agent in this workspace, named from the
 *            prompt, on the harness last used — the chip picks another. It
 *            stands in for the crew's old ＋ seat.
 *
 * "@Name the rest" sends to that agent from anywhere.
 */

export interface PromptAgent {
  id: string
  name: string
  /** The terminal is a line into a session elsewhere: nothing here attaches. */
  remote: boolean
}

interface GlobalPromptProps {
  /** The agent whose full view is showing, if any. */
  fullAgentId: string | null
  agents: readonly PromptAgent[]
  /** The harnesses a new agent can take (saved teams left out). */
  harnesses: readonly string[]
  /** The workspace's cards, so a new one is stored beside them. */
  nodes: readonly CanvasNode[]
  /** The dock's ORCH switch: a new agent leads the crew when it is on. */
  orch?: boolean
}

/** The zoom's open card, read as one id so the box re-renders only when it changes. */
function useCardAgent(): string | null {
  return useSyncExternalStore(
    zoomStore.subscribe,
    () => promptTargetOf({ zoom: zoomStore.get(), fullAgentId: null }),
    () => null
  )
}

export function GlobalPrompt({ fullAgentId, agents, harnesses, nodes, orch = false }: GlobalPromptProps): React.JSX.Element {
  const cardAgent = useCardAgent()
  const viewed = fullAgentId ?? cardAgent
  // While the box has focus its agent holds still: the view may move on (a
  // newly waiting agent takes the stage), the words being typed may not.
  const [held, setHeld] = useState<{ id: string | null } | null>(null)
  const targetId = held && (held.id === null || agents.some((a) => a.id === held.id)) ? held.id : viewed
  const target = agents.find((a) => a.id === targetId) ?? null
  // Let go of @agent until the view moves to another one.
  const [released, setReleased] = useState<string | null>(null)
  useEffect(() => setReleased(null), [targetId])
  const to = target && target.id !== released ? target : null

  const [text, setText] = useDraft(draftKey(to?.id ?? null))
  // The harness last used — read again whenever the offered list changes (the
  // first render sees only a placeholder list), until a pick here overrides it.
  const picked = useRef<string | null>(null)
  const offered = harnesses.join('\u0000')
  const [harness, setHarness] = useState(() => lastHarness(harnesses))
  useEffect(() => {
    setHarness(picked.current && harnesses.includes(picked.current) ? picked.current : lastHarness(harnesses))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered])
  /** The harness menu, anchored over its chip: the dock clips anything that hangs out of it. */
  const [picking, setPicking] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => setPicking(null), [to?.id])
  useEffect(() => {
    if (!picking) return
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.target instanceof Element && e.target.closest('.cr-prompt-menu, .cr-prompt-harness')) return
      setPicking(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [picking])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activity = useLiveLine(to?.id ?? null)
  const names = agents.map((a) => a.name)
  /** The draft, and the agent's line with it (unless an IME is mid-word). */
  const write = (next: string, composing = false): void => {
    setText(next)
    if (to && !composing) typeLine(to.id, lineTextFor(next, to.id, mentionTarget(next, agents), names))
  }
  // Words held back while the agent asked a question go in once it is done asking.
  const asked = useRef<{ id: string | null; waiting: boolean }>({ id: null, waiting: false })
  const phase = activity?.phase
  useEffect(() => {
    const waiting = phase === 'waiting'
    const id = to?.id ?? null
    if (id && asked.current.id === id && asked.current.waiting && !waiting) {
      const draft = getDraft(draftKey(id))
      typeLine(id, lineTextFor(draft, id, mentionTarget(draft, agents), names))
    }
    asked.current = { id, waiting }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, to?.id])

  const makeNew = async (prompt: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const made = await makeAgent(cookrew(), { name: nameFromPrompt(prompt), preset: harness, orch, prompt }, nodes)
    setBusy(false)
    if (made.ok) setText('')
    else setError(made.error)
  }

  const submit = (): void => {
    setError(null)
    // "@Other …" goes to Other, whoever the box is carrying.
    const mention = mentionTarget(text, agents)
    if (mention && mention.id !== to?.id) {
      if (!mention.text) return
      sendToAgent(mention.id, mention.text)
      // Enter took whatever sat in Other's line along with the words.
      endLine(mention.id)
      setText('')
      return
    }
    if (to) {
      const words = mention ? mention.text : text
      // A bare Enter only where its terminal is in sight: from a card it
      // could answer a permission prompt nobody is looking at.
      if (!words.trim() && to.id !== fullAgentId) return
      submitLine(to.id, words.trim() ? words : '')
      return
    }
    const prompt = text.trim()
    if (prompt && !busy) void makeNew(prompt)
  }

  const pick = (name: string): void => {
    picked.current = name
    setHarness(name)
    rememberHarness(name)
    setPicking(null)
  }

  return (
    <form
      className={`cr-prompt${to ? ' to-agent' : ' to-new'}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {to ? (
        <span className="cr-prompt-to" title={`Prompts go to ${to.name}`}>
          <b>@{to.name}</b>
          <button
            type="button"
            aria-label={`Stop prompting ${to.name}`}
            title="Prompt nobody: a new agent takes it"
            onClick={() => {
              setReleased(to.id)
              setHeld(null)
            }}
          >
            ×
          </button>
        </span>
      ) : (
        <span className="cr-prompt-new">
          <button
            type="button"
            className="cr-prompt-harness"
            aria-haspopup="menu"
            aria-expanded={picking !== null}
            title="The harness the new agent runs"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setPicking((open) => (open ? null : { left: r.left, bottom: window.innerHeight - r.top + 6 }))
            }}
          >
            ＋ {harness} ▾
          </button>
          {picking && (
            <span className="cr-prompt-menu" role="menu" style={{ left: picking.left, bottom: picking.bottom }}>
              {harnesses.map((name) => (
                <button key={name} type="button" role="menuitemradio" aria-checked={name === harness} onClick={() => pick(name)}>
                  {name}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      <input
        type="text"
        value={text}
        placeholder={to ? `Prompt ${to.name}…` : 'A new agent takes this task: describe it…'}
        aria-label={to ? `Prompt ${to.name}` : 'Prompt for a new agent'}
        autoComplete="off"
        disabled={busy}
        onChange={(e) => write(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
        onCompositionEnd={(e) => write(e.currentTarget.value)}
        onFocus={() => setHeld({ id: to?.id ?? null })}
        onBlur={() => setHeld(null)}
        onKeyDown={(e) => {
          // The zoom's keys (Esc steps out) are not this box's.
          e.stopPropagation()
          if (e.key === 'Backspace' && !e.repeat && to && text === '') {
            setReleased(to.id)
            setHeld({ id: null })
          }
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      {to && <VoiceBar key={to.id} terminalId={to.id} activity={activity} remote={to.remote} onDictation={(words) => write(text.trim() ? `${text.trimEnd()} ${words}` : words)} sendButton={false} />}
      <button type="submit" className="cr-btn sm primary" title={to ? 'Send (Enter)' : 'Make the agent (Enter)'} aria-label="Send" disabled={busy || (!text.trim() && to?.id !== fullAgentId) || (!to && !text.trim())}>
        <CrIcon name="send" />
      </button>
      {error && (
        <span className="cr-prompt-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </form>
  )
}
