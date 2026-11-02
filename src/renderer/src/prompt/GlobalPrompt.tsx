import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasNode } from '../../../shared/model'
import { addressedToSous } from '../../../shared/sous-intent'
import { cookrew, isRemoteMode } from '../api'
import { CrIcon } from '../icons'
import { speakSous } from '../sous-speak'
import { VoiceBar } from '../VoiceBar'
import { makeAgent } from '../zoom/make-card'
import { CardTune } from '../nodes/CardTune'
import type { LaunchKnob } from '../../../shared/launch-tune'
import { zoomStore } from '../zoom/zoom-store'
import { nameFromPrompt } from '../../../shared/agent-name'
import { lastHarness, rememberHarness } from './harness-pref'
import { lastLaunchTune, offeredPart, rememberLaunchTune, withLaunchKnob } from './launch-pref'
import { NewAgentTune } from './NewAgentTune'
import { usePresetOffers } from './use-preset-commands'
import { HarnessMenu, type NewMenuActs } from './HarnessMenu'
import { artifactRefs, expandRefs, pendingName, suggestionsFor, type ArtifactRef, type PromptArtifact } from './artifact-refs'
import { endLine, lineTextFor, submitLine, typeLine, useLiveLine } from './live-line'
import { withHeard } from './dictation'
import { draftKey, getDraft, setDraft, useDraft } from './prompt-draft'
import { boxPin, boxTargetId, heldAfter, mentionTarget, promptTargetOf, releaseAfter, zoomMoveKey, type Release } from './prompt-target'
import { sendToAgent } from './send'
import { useDictation } from './use-dictation'
import { usePromptAttach } from './use-prompt-attach'
import { useDropZone } from './drop-zone'
import { keyboardCoverNow, riseOver, type RiseAnchor } from './rise-anchor'
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
 *            lets go of the agent until the view moves: stepping into any
 *            agent's card or full view brings @agent back.
 *   nobody   the prompt makes a new agent in this workspace, named from the
 *            prompt (a stand-in at once, Sous's name once it answers), on the
 *            harness last used — the chip picks another. It stands in for the
 *            crew's old ＋ seat, and its menu for the dock's retired TERMINAL
 *            button (HarnessMenu.tsx).
 *
 * THE TUNE CHIP sits beside the left chip (owner, 2026-11-01; it left the top
 * bar): aimed at an agent it is that agent's own model · effort · route
 * button (CardTune.tsx), turned live; with nobody targeted it picks what the
 * new agent starts on (NewAgentTune.tsx), sent as launch flags. Every pick in
 * a chip (the harness, a model, an effort, a route) puts the caret back in the
 * box, so the prompt is typed next (owner, 2026-11-01).
 *
 * "@Name the rest" sends to that agent from anywhere. "#Name" names a note or
 * a browser of this workspace (artifact-refs.ts): it is sent as what it is,
 * and wired to the agent it goes to. Typing "@" or "#" offers the names.
 * A screenshot pasted or a file dropped goes in as its path
 * (prompt-attach.ts).
 *
 * VOICE lands here too, and only here (use-dictation.ts): the mic, or ⌘
 * held, puts the words into the draft to be read and sent, for an agent or
 * for a new one. A sentence addressed to Sous ("Sous, switch to …") goes to
 * Sous instead; if it was no command after all, it lands in the draft.
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
  /** What the ＋ menu opens at once: a shell, roles, saved teams, ORCH (HarnessMenu.tsx). */
  acts?: NewMenuActs
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

/** The zoom's deliberate moves, as one key (zoomMoveKey): a release lasts until the next one. */
function useZoomMoveKey(): string {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomMoveKey(zoomStore.get()), () => '')
}

export function GlobalPrompt({ fullAgentId, agents, harnesses, nodes, orch = false, artifacts = NO_ARTIFACTS, acts }: GlobalPromptProps): React.JSX.Element {
  const cardAgent = useCardAgent()
  const viewed = fullAgentId ?? cardAgent
  const moveKey = useZoomMoveKey()
  const known = (id: string): boolean => agents.some((a) => a.id === id)
  // While the box has focus, words showing in it hold its agent still: the
  // view may move on (a newly waiting agent takes the stage), the words being
  // typed may not. An empty box follows the view (prompt-target.ts).
  const [held, setHeld] = useState<{ id: string | null } | null>(null)
  const heldWords = useDraft(draftKey(held?.id ?? null))[0]
  // So do they while it listens: the words go where they were meant for.
  const [aim, setAim] = useState<{ id: string | null } | null>(null)
  // Let go of @agent until the view moves: a deliberate move of the zoom, or
  // another agent on show (prompt-target.ts · releaseAfter).
  const [released, setReleased] = useState<Release | null>(null)
  useEffect(() => setReleased(null), [moveKey])
  const release = releaseAfter(released, viewed)
  useEffect(() => {
    if (release !== released) setReleased(release)
  }, [release, released])
  /**
   * Let go of an agent. The focused box's hold goes with it: a hold left on
   * the agent (its words still drafted) would pin it back the moment the
   * release ends, carrying its old words into the box.
   */
  const letGo = (id: string): void => {
    setReleased({ id, viewed })
    setHeld((h) => (h ? { id: null } : h))
  }
  const targetId = boxTargetId({ viewed, pin: boxPin(aim, held, heldWords), released: release, known })
  const to = agents.find((a) => a.id === targetId) ?? null
  // An empty box's hold moves with it, so the words typed next stay put.
  useEffect(() => {
    const next = heldAfter(held, { boxId: to?.id ?? null, heldWords, known })
    if (next !== held) setHeld(next)
  })

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
  const [picking, setPicking] = useState<RiseAnchor | null>(null)
  useEffect(() => setPicking(null), [to?.id])
  useEffect(() => {
    if (!picking) return
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return
        // The menu's Esc: the box behind it keeps its caret.
        e.stopPropagation()
      } else if (e.target instanceof Element && e.target.closest('.cr-prompt-menu, .cr-prompt-harness')) return
      setPicking(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [picking])
  // The new agent's model and effort: sticky like the harness, sent only as
  // far as the harness takes them (shared/launch-tune).
  // Each harness keeps its own pick: a codex model means nothing to claude.
  const offer = usePresetOffers().get(harness) ?? null
  const [launchTune, setLaunchTune] = useState(() => lastLaunchTune(harness))
  useEffect(() => setLaunchTune(lastLaunchTune(harness)), [harness])
  const pickLaunch = (knob: LaunchKnob, value: string | null): void => {
    const next = withLaunchKnob(launchTune, knob, value)
    setLaunchTune(next)
    rememberLaunchTune(harness, next)
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activity = useLiveLine(to?.id ?? null)
  const names = agents.map((a) => a.name)
  /** The draft, and the agent's line with it (unless an IME is mid-word). */
  const write = (next: string, composing = false): void => {
    setText(next)
    if (to && !composing) typeLine(to.id, lineTextFor(next, to.id, mentionTarget(next, agents), names, artifacts))
  }

  /**
   * Heard words into the draft of the agent they were meant for, as that
   * draft is NOW: the owner may have typed on while the ear closed, and Sous
   * may answer after an edit.
   */
  const aimRef = useRef<string | null>(null)
  const landRef = useRef((_words: string, _id: string | null): void => undefined)
  landRef.current = (words, id) => {
    const next = withHeard(getDraft(draftKey(id)), words)
    setDraft(draftKey(id), next)
    if (id && agents.some((a) => a.id === id)) typeLine(id, lineTextFor(next, id, mentionTarget(next, agents), names, artifacts))
  }
  /** What Sous said back to a spoken command, for a beat. */
  const [sous, setSous] = useState<string | null>(null)
  useEffect(() => {
    if (!sous) return
    const timer = window.setTimeout(() => setSous(null), 3500)
    return () => window.clearTimeout(timer)
  }, [sous])
  const dictation = useDictation({
    onStart: () => {
      setError(null)
      aimRef.current = to?.id ?? null
      setAim({ id: aimRef.current })
    },
    onFinal: (words, alternates) => {
      const id = aimRef.current
      setAim(null)
      // The Mac's other ear may have caught "Sous" where the first one heard
      // another syllable: any reading addressed to Sous asks Sous.
      const readings = [words, ...alternates]
      const addressed = readings.find(addressedToSous)
      if (!addressed) return landRef.current(words, id)
      void cookrew()
        .sousCommand(addressed, { surface: isRemoteMode() ? 'phone' : 'canvas', alternates: readings.filter((r) => r !== addressed) })
        .then((result) => {
          if (result.intent === 'none') return landRef.current(words, id)
          // Refused: the sentence stays, to be fixed and said (or sent) again.
          if (result.intent === 'refused') {
            landRef.current(words, id)
            setError(result.spoken || `Sous could not do "${words}".`)
          } else setSous(result.spoken || null)
          speakSous(result.spoken)
        })
        .catch((e: unknown) => {
          landRef.current(words, id)
          setError(`Sous did not answer: ${String(e)}`)
        })
    },
    onError: (message) => {
      setAim(null)
      setError(message)
    }
  })
  const hearing = dictation.phase === 'hearing'
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
    const tune = offeredPart(launchTune, offer)
    const made = await makeAgent(cookrew(), { name: nameFromPrompt(prompt), preset: harness, orch, prompt, autoName: true, tune }, nodes)
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
  const attach = usePromptAttach({
    draftKey: draftKey(to?.id ?? null),
    write,
    inputRef,
    refusal: to?.remote ? `Screenshots stay on this machine: ${to.name} runs elsewhere.` : null,
    onError: setError
  })
  // The whole box takes a dropped screenshot, with the transcripts view's cue over it.
  const formRef = useRef<HTMLFormElement>(null)
  const dropOver = useDropZone(formRef, attach.dropFiles)
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
  /** A chip's pick is made: the prompt is what comes next. */
  const focusBox = (): void => inputRef.current?.focus()

  const pick = (name: string): void => {
    picked.current = name
    setHarness(name)
    rememberHarness(name)
    setPicking(null)
    focusBox()
  }

  return (
    <form
      ref={formRef}
      className={`cr-prompt${to ? ' to-agent' : ' to-new'}${attach.attaching ? ' attaching' : ''}${hearing ? ' listening' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (dictation.listening) return
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
            onClick={() => letGo(to.id)}
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
            title={orch ? 'The harness the new agent runs · ORCH: it leads the crew' : 'The harness the new agent runs — or open a shell or a team'}
            onClick={(e) => {
              const at = riseOver(e.currentTarget.getBoundingClientRect(), window.innerHeight, keyboardCoverNow())
              setPicking((open) => (open ? null : at))
            }}
          >
            ＋ {harness}
            {orch && <small className="cr-prompt-orch">ORCH</small>} ▾
          </button>
          {picking && <HarnessMenu at={picking} harnesses={harnesses} harness={harness} onPick={pick} orch={orch} acts={acts} onDone={() => setPicking(null)} />}
        </span>
      )}
      {/* The chip and the voice bar are siblings in this form: one key each,
          never the bare agent id twice, or a retarget leaves the old chip behind. */}
      {to ? (
        <CardTune key={`tune:${to.id}`} terminalId={to.id} phase={activity?.phase ?? 'idle'} remote={to.remote} onMouseDown={(e) => e.preventDefault()} rise onTurned={focusBox} />
      ) : (
        offer && (
          <NewAgentTune
            offer={offer}
            tune={offeredPart(launchTune, offer)}
            onPick={(knob, value) => {
              pickLaunch(knob, value)
              focusBox()
            }}
          />
        )
      )}
      {suggesting && anchor && pending && (
        <span className="cr-prompt-menu cr-prompt-suggest" role="listbox" aria-label={pending.sigil === '@' ? 'Agents' : 'Notes and browsers'} style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 6 }}>
          {options.map((option, i) => (
            <button
              key={`${option.kind}:${option.name}`}
              type="button"
              role="option"
              aria-selected={i === chosen}
              // Keep the input's focus (and the agent its words hold) while picking.
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
        value={hearing ? withHeard(text, dictation.heard) : text}
        readOnly={hearing}
        placeholder={hearing ? 'Listening…' : to ? `Prompt ${to.name}… # a note or browser` : 'Describe a task for a new agent…'}
        aria-label={to ? `Prompt ${to.name}` : 'Prompt for a new agent'}
        title="Paste or drop a screenshot: its path goes into the prompt"
        autoComplete="off"
        disabled={busy}
        onPaste={attach.onPaste}
        onChange={(e) => {
          if (!hearing) write(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)
        }}
        onCompositionEnd={(e) => {
          // The shown value carries the heard words while listening; they land once, from the ear.
          if (!hearing) write(e.currentTarget.value)
        }}
        onFocus={() => setHeld({ id: to?.id ?? null })}
        onBlur={() => setHeld(null)}
        onKeyDown={(e) => {
          // The zoom's keys (Esc steps out) are not this box's.
          e.stopPropagation()
          // Enter while listening closes the ear: the words land, and are sent
          // by the next Enter, once they have been seen. (Send is disabled
          // meanwhile, so the form would not even see this Enter.)
          if (e.key === 'Enter' && dictation.listening) {
            e.preventDefault()
            dictation.stop()
            return
          }
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
          if (e.key === 'Backspace' && !e.repeat && to && text === '') letGo(to.id)
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      {to && <VoiceBar key={`voice:${to.id}`} terminalId={to.id} activity={activity} remote={to.remote} />}
      {dictation.ear && (
        <button
          type="button"
          className={`cr-btn sm voice-mic${dictation.listening ? ' listening' : ''}`}
          title={dictation.listening ? 'Stop: the words go into the prompt' : 'Dictate into the prompt (or hold ⌘)'}
          aria-label={dictation.listening ? 'Stop dictating' : 'Dictate'}
          aria-pressed={dictation.listening}
          // Keep the caret where it was: the words land in the draft either way.
          onMouseDown={(e) => e.preventDefault()}
          onClick={dictation.toggle}
        >
          <CrIcon name="mic" />
        </button>
      )}
      <button type="submit" className="cr-btn sm primary" title={to ? 'Send (Enter)' : 'Make the agent (Enter)'} aria-label="Send" disabled={busy || dictation.listening || (!text.trim() && to?.id !== fullAgentId) || (!to && !text.trim())}>
        <CrIcon name="send" />
      </button>
      {attach.attaching && (
        <span className="cr-prompt-note" role="status">
          attaching…
        </span>
      )}
      {dictation.phase === 'closing' && dictation.heard.trim() && (
        <span className="cr-prompt-note cr-prompt-sous" role="status" title={dictation.heard}>
          … {dictation.heard}
        </span>
      )}
      {sous && !error && (
        <span className="cr-prompt-note cr-prompt-sous" role="status" title={sous}>
          Sous: {sous}
        </span>
      )}
      {error && (
        <span className="cr-prompt-error" role="alert" title={error}>
          {error}
        </span>
      )}
      {dropOver && (
        <div className="attach-drop-hint cr-prompt-drop">
          <span>
            <CrIcon name="attach" /> {to?.remote ? 'ATTACHMENTS STAY HERE — THIS TEAM RUNS ELSEWHERE' : 'DROP TO ATTACH'}
          </span>
        </div>
      )}
    </form>
  )
}
