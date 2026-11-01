import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasNode } from '../../../shared/model'
import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { VoiceBar } from '../VoiceBar'
import { makeAgent } from '../zoom/make-card'
import { zoomStore } from '../zoom/zoom-store'
import { nameFromPrompt } from '../../../shared/agent-name'
import { lastHarness, rememberHarness } from './harness-pref'
import { artifactRefs, expandRefs, pendingName, suggestionsFor, type ArtifactRef, type PromptArtifact } from './artifact-refs'
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
 *            prompt (a stand-in at once, Sous's name once it answers), on the
 *            harness last used — the chip picks another. It stands in for the
 *            crew's old ＋ seat.
 *
 * "@Name the rest" sends to that agent from anywhere. "#Name" names a note or
 * a browser of this workspace (artifact-refs.ts): it is sent as what it is,
 * and wired to the agent it goes to. Typing "@" or "#" offers the names.
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
  /** The workspace's notes and browsers, for "#Name". */
  artifacts?: readonly PromptArtifact[]
}

type Suggestion = { name: string; kind: 'agent' | 'note' | 'browser' }

const NO_ARTIFACTS: readonly PromptArtifact[] = []

/** The zoom's open card, read as one id so the box re-renders only when it changes. */
function useCardAgent(): string | null {
  return useSyncExternalStore(
    zoomStore.subscribe,
    () => promptTargetOf({ zoom: zoomStore.get(), fullAgentId: null }),
    () => null
  )
}

export function GlobalPrompt({ fullAgentId, agents, harnesses, nodes, orch = false, artifacts = NO_ARTIFACTS }: GlobalPromptProps): React.JSX.Element {
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
    if (to && !composing) typeLine(to.id, lineTextFor(next, to.id, mentionTarget(next, agents), names, artifacts))
  }
  // Words held back while the agent asked a question go in once it is done asking.
  const asked = useRef<{ id: string | null; waiting: boolean }>({ id: null, waiting: false })
  const phase = activity?.phase
  useEffect(() => {
    const waiting = phase === 'waiting'
    const id = to?.id ?? null
    if (id && asked.current.id === id && asked.current.waiting && !waiting) {
      const draft = getDraft(draftKey(id))
      typeLine(id, lineTextFor(draft, id, mentionTarget(draft, agents), names, artifacts))
    }
    asked.current = { id, waiting }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, to?.id])

  /** Each "#Name" sent to an agent becomes one of its own: wired, unless it is already. */
  const wireRefs = (agentId: string, refs: readonly ArtifactRef[]): void => {
    const seen = new Set<string>()
    for (const { artifact } of refs) {
      if (seen.has(artifact.id) || artifact.owners.includes(agentId)) continue
      seen.add(artifact.id)
      void cookrew()
        .connectNodes(agentId, artifact.id)
        .catch((e: unknown) => setError(`#${artifact.name} could not be given to the agent: ${String(e)}`))
    }
  }
  /** The words as sent: each "#Name" said as what it is. */
  const said = (words: string): { words: string; refs: ArtifactRef[] } => {
    const refs = artifactRefs(words, artifacts)
    return { words: expandRefs(words, refs), refs }
  }

  const makeNew = async (raw: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const { words: prompt, refs } = said(raw)
    const made = await makeAgent(cookrew(), { name: nameFromPrompt(prompt), preset: harness, orch, prompt, autoName: true }, nodes)
    setBusy(false)
    if (!made.ok) return setError(made.error)
    if (made.id) wireRefs(made.id, refs)
    setText('')
  }

  const submit = (): void => {
    setError(null)
    // "@Other …" goes to Other, whoever the box is carrying.
    const mention = mentionTarget(text, agents)
    if (mention && mention.id !== to?.id) {
      if (!mention.text) return
      const out = said(mention.text)
      sendToAgent(mention.id, out.words)
      wireRefs(mention.id, out.refs)
      // Enter took whatever sat in Other's line along with the words.
      endLine(mention.id)
      setText('')
      return
    }
    if (to) {
      const out = said(mention ? mention.text : text)
      // A bare Enter only where its terminal is in sight: from a card it
      // could answer a permission prompt nobody is looking at.
      if (!out.words.trim() && to.id !== fullAgentId) return
      submitLine(to.id, out.words.trim() ? out.words : '')
      wireRefs(to.id, out.refs)
      return
    }
    const prompt = text.trim()
    if (prompt && !busy) void makeNew(prompt)
  }

  // "@…" and "#…" offer the names they could become, while the box has focus.
  const inputRef = useRef<HTMLInputElement>(null)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const pending = held ? pendingName(text, { '@': names, '#': artifacts.map((a) => a.name) }) : null
  const options: Suggestion[] = !pending
    ? []
    : pending.sigil === '@'
      ? suggestionsFor(pending.query, agents.map((a): Suggestion => ({ name: a.name, kind: 'agent' })))
      : suggestionsFor(pending.query, artifacts)
  const suggesting = options.length > 0 && dismissedAt !== text
  const chosen = Math.min(sel, Math.max(0, options.length - 1))
  useEffect(() => setSel(0), [pending?.sigil, pending?.query])
  const choose = (name: string): void => {
    if (!pending) return
    write(`${text.slice(0, pending.start)}${pending.sigil}${name} `)
    inputRef.current?.focus()
  }
  const anchor = suggesting ? inputRef.current?.getBoundingClientRect() : undefined

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
      {suggesting && anchor && pending && (
        <span className="cr-prompt-menu cr-prompt-suggest" role="listbox" aria-label={pending.sigil === '@' ? 'Agents' : 'Notes and browsers'} style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 6 }}>
          {options.map((option, i) => (
            <button
              key={`${option.kind}:${option.name}`}
              type="button"
              role="option"
              aria-selected={i === chosen}
              // Keep the input's focus (and its held agent) while picking.
              onMouseDown={(e) => {
                e.preventDefault()
                choose(option.name)
              }}
            >
              <CrIcon name={option.kind === 'agent' ? 'terminal' : option.kind} />
              <span>{option.name}</span>
              <small>{option.kind}</small>
            </button>
          ))}
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        value={text}
        placeholder={to ? `Prompt ${to.name}… # a note or browser` : 'A new agent takes this task: describe it…'}
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
          if (suggesting) {
            const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
            if (step !== 0) {
              e.preventDefault()
              setSel((chosen + step + options.length) % options.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              choose(options[chosen].name)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setDismissedAt(text)
              return
            }
          }
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
