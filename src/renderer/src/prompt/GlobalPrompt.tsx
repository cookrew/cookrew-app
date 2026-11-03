import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
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
import { lastLaunchTune, offeredPick, rememberLaunchTune, withLaunchKnob } from './launch-pref'
import { NewAgentTune, type NewAgentGateway } from './NewAgentTune'
import { useRouteState } from '../routing/use-route-state'
import { routeChoices } from '../../../shared/route-view'
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
import { ExtrasToggle, PromptExtras, useFilePicker } from './PromptExtras'
import { extrasShown, rememberExtras, toolsOpen } from './extras-pref'
import { useSpokenReplies } from './use-spoken-replies'
import { PictureStrip, picturesOfDraft } from '../pictures/PictureStrip'
import { shownWords, withoutLastPicture, withoutPicture, withShownWords } from './draft-pictures'
import { keyboardCoverNow, riseOver, type RiseAnchor, topBarBottom } from './rise-anchor'
import { useCrewContext } from '../stage/crew-rows'
import { inkStatusOfRow } from '../zoom/ink-status'
import type { AgentRow } from '../agent-rows'
import { boxFold, facePlace, promptFold, usePromptOpen } from './prompt-fold'
import { flyFace, popFace, type Box } from './face-flip'
import { useFaceSlot } from './face-slot'
import { enterOpensBox, keepsBoxOpen, pressOnCanvas } from './enter-opens'
import { latestUser, usersInView } from './item-user'
import { PromptFace, type FaceAgent } from './PromptFace'
import { InkAvatar } from '../zoom/InkAvatar'
import { WhoPicker } from './WhoPicker'
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
 * THE TOOLS (owner, 2026-11-03): 📎 attach, 🔊 spoken replies and, with an
 * agent in the box, its keys (arrows, paste, Esc), flat like the mic, for a
 * new agent too, behind one ^ that shows or hides them all (PromptExtras.tsx,
 * extras-pref.ts). It opens by itself while the agent waits on you.
 *
 * THE FACE IS THE SEND KEY (owner, 2026-11-04): the box folds into the face of
 * whoever the words go to, at the right end of the zoom's bar (prompt-fold.ts,
 * PromptFace.tsx); a tap or Enter (no field focused) opens it, Esc or a tap
 * elsewhere folds it, the words kept as its draft. Open, the face is the send
 * key, and with no words it chooses who (WhoPicker.tsx). In a browser's or a
 * note's full view the face is the item's latest user (item-user.ts).
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
  /** What the ＋ menu opens at once: a shell, the saved roles (HarnessMenu.tsx). */
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

/** Which full view stands, and the item the zoom holds: where the face folds, and whose it is. */
function useZoomFull(): 'agent' | 'item' | null {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomStore.get().full, () => null)
}
function useZoomItem(): string | null {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomStore.get().item, () => null)
}
/** The zoom's side and where on it: at the artifacts, their users lead the picker (item-user.ts · usersInView). */
function useZoomDir(): 'agents' | 'items' {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomStore.get().dir, () => 'agents' as const)
}
function useZoomV(): number {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomStore.get().v, () => -1)
}

/** How long a released press's click may take to arrive (a finger's tap is the slow one). */
const CLICK_GRACE_MS = 350

const NO_ROWS: readonly AgentRow[] = []
const NO_IDS: readonly string[] = []

/** An agent's face as its crew row draws it; a plain one before the crew knows it. */
function faceOf(id: string, name: string, rows: readonly AgentRow[], fallbackPreset: string): FaceAgent {
  const row = rows.find((r) => r.id === id)
  return row
    ? { id, name: row.name, preset: row.preset, orch: row.orch, status: inkStatusOfRow(row.phase, row.unread) }
    : { id, name, preset: fallbackPreset, orch: false, status: 'idle' }
}

/** The zoom's deliberate moves, as one key (zoomMoveKey): a release lasts until the next one. */
function useZoomMoveKey(): string {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomMoveKey(zoomStore.get()), () => '')
}

export function GlobalPrompt({ fullAgentId, agents, harnesses, nodes, orch = false, artifacts = NO_ARTIFACTS, acts }: GlobalPromptProps): React.JSX.Element {
  const cardAgent = useCardAgent()
  const crewRows = useCrewContext()?.crew ?? NO_ROWS
  const zoomFull = useZoomFull()
  const zoomItem = useZoomItem()
  // A browser's or a note's full view talks to its latest user (item-user.ts).
  const itemOwners = zoomFull === 'item' && zoomItem ? (artifacts.find((a) => a.id === zoomItem)?.owners ?? NO_IDS) : NO_IDS
  const zoomDir = useZoomDir()
  const zoomV = useZoomV()
  const moveKey = useZoomMoveKey()
  // Read once per entry into the item's view (and again while nobody is known
  // yet): its users' activity must not move the face under the eye.
  const itemKey = zoomFull === 'item' && zoomItem ? `${moveKey}|${zoomItem}` : null
  const itemUser = useRef<{ key: string | null; id: string | null }>({ key: null, id: null })
  if (itemUser.current.key !== itemKey || (itemKey !== null && itemUser.current.id === null)) {
    itemUser.current = { key: itemKey, id: itemKey ? latestUser(itemOwners, crewRows) : null }
  }
  const viewed = fullAgentId ?? cardAgent ?? itemUser.current.id
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
  // The who-picker's pick stands in for the view's agent until the same move.
  const [pickedAgent, setPickedAgent] = useState<string | null>(null)
  useEffect(() => {
    setReleased(null)
    setPickedAgent(null)
  }, [moveKey])
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
    // Let go, the box stays open for the new agent's words (a fold is a choice).
    promptFold.open()
  }
  const targetId = boxTargetId({ viewed, pin: boxPin(aim, held, heldWords), released: release, known, picked: pickedAgent })
  const to = agents.find((a) => a.id === targetId) ?? null
  // An empty box's hold moves with it, so the words typed next stay put.
  useEffect(() => {
    const next = heldAfter(held, { boxId: to?.id ?? null, heldWords, known })
    if (next !== held) setHeld(next)
  })

  const [text, setText] = useDraft(draftKey(to?.id ?? null))
  // The box shows the words; its pictures are drawn, their paths kept out of sight (draft-pictures.ts).
  const shown = shownWords(text)
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
  // An updater: a model pick may drop the effort in the same click (NewAgentTune.pickModel).
  const pickLaunch = (knob: LaunchKnob, value: string | null): void => {
    setLaunchTune((prev) => {
      const next = withLaunchKnob(prev, knob, value)
      rememberLaunchTune(harness, next)
      return next
    })
  }
  // THE ONE MODEL LIST (owner 2026-11-04): with the gateway online, a new
  // claude agent picks a route or a direct alias from the live dial's rows.
  const route = useRouteState().state
  const gateway: NewAgentGateway | null =
    route?.status === 'online' && route.models.length > 0
      ? { ids: routeChoices(route.models), models: route.models, defaultModel: route.defaultModel }
      : null
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
  // ONE FOLD FOR EVERY TOOL (owner, 2026-11-03): the ^ shows or hides attach,
  // 🔊 and the agent's keys (arrows, paste, Esc) together; ⌨ is gone. The
  // pick sticks (extras-pref.ts). The keys are for answering the agent, so
  // the fold opens by itself while it waits on you (owner, 2026-11-02); a tap
  // on the ^ overrides that until the agent starts or stops waiting, or
  // another agent takes the box.
  const waitingOnYou = phase === 'waiting'
  const [extrasOn, setExtrasOn] = useState(extrasShown)
  const [toolsPick, setToolsPick] = useState<boolean | null>(null)
  useEffect(() => setToolsPick(null), [to?.id, waitingOnYou])
  const toolsShown = toolsOpen(toolsPick, extrasOn, to !== null && waitingOnYou)
  const toggleTools = (): void => {
    const next = !toolsShown
    setToolsPick(next)
    setExtrasOn(next)
    rememberExtras(next)
  }
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
    const tune = offeredPick(launchTune, offer, gateway)
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
    aside: true,
    onError: setError
  })
  // The whole box takes a dropped screenshot, with the transcripts view's cue over it.
  const formRef = useRef<HTMLFormElement>(null)
  const dropOver = useDropZone(formRef, attach.dropFiles)
  const spoken = useSpokenReplies(to?.id ?? null, activity, agents)
  const browse = useFilePicker(attach.dropFiles)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const pending = held ? pendingName(shown, { '@': names, '#': artifacts.map((a) => a.name) }) : null
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
    write(withShownWords(text, `${shown.slice(0, pending.start)}${pending.sigil}${name} `))
    inputRef.current?.focus()
  }
  const anchor = suggesting ? inputRef.current?.getBoundingClientRect() : undefined
  /** A chip's pick is made: the prompt is what comes next. */
  const focusBox = (): void => inputRef.current?.focus()

  // THE FOLD (prompt-fold.ts): the face stands on the zoom's bar at its stops,
  // alone in a corner over a browser or a note; an agent's full view keeps the
  // box open. With no bar mounted (the board), the box never folds.
  const faceSlot = useFaceSlot()
  const place = facePlace(zoomFull)
  const open = usePromptOpen()
  // An agent in the box holds it open, in place of the bar (prompt-fold.ts · boxFold).
  const { canFold: foldable, folded, overBar } = boxFold({ place, slot: faceSlot !== null, pinned: to !== null, open })
  const [who, setWho] = useState(false)
  useEffect(() => setWho(false), [to?.id, folded])
  // The picker is for an empty box: words typed with it open close it, so a
  // pick never lands while words hold the box on someone else.
  useEffect(() => {
    if (text.trim() !== '') setWho(false)
  }, [text])
  // Where the box cannot fold (an agent's full view), it is not left open
  // behind it: back at the stops it starts folded, the bar in view.
  useEffect(() => {
    if (!foldable) promptFold.fold()
  }, [foldable])
  // The store outlives the box (the board's view unmounts it): leave it as
  // if no box were there, or the zoom's Esc would fold nothing.
  useEffect(
    () => () => {
      promptFold.setFoldable(false)
      promptFold.fold()
    },
    []
  )
  // Folded, the box has no focus: words no longer pin it (a hidden input
  // fires no blur), so the face follows the view again, the words kept.
  useEffect(() => {
    if (folded) setHeld(null)
  }, [folded])
  useEffect(() => promptFold.setFoldable(foldable), [foldable])
  // In the layout pass: the face's flight measures the open box, which these classes un-hide.
  useLayoutEffect(() => {
    const body = document.body.classList
    body.toggle('cr-prompt-folded', folded)
    body.toggle('cr-prompt-open', overBar)
    body.toggle('cr-prompt-corner', place === 'corner')
    return () => {
      body.remove('cr-prompt-folded')
      body.remove('cr-prompt-open')
      body.remove('cr-prompt-corner')
    }
  }, [folded, overBar, place])
  /** Open, and the caret in the box in the same gesture (a phone raises its keyboard only then). */
  const openBox = (): void => {
    flushSync(() => promptFold.open())
    inputRef.current?.focus()
  }
  // Enter opens it while nothing that takes keys has them (enter-opens.ts).
  useEffect(() => {
    if (!folded) return
    const onKey = (e: KeyboardEvent): void => {
      if (!enterOpensBox(e, e.target instanceof Element ? e.target : null)) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      openBox()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded])
  // A primary press anywhere else folds it. On the zoom's canvas it only
  // folds, as a press outside a menu closes it (else it would also zoom out
  // or open a card); anywhere else (the header, a page, a dialog) it goes on
  // to do what it does.
  useEffect(() => {
    if (!foldable || folded) return
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !e.isPrimary) return
      const target = e.target instanceof Element ? e.target : null
      if (keepsBoxOpen(target)) return
      setPicking(null)
      promptFold.fold()
      if (!pressOnCanvas(target)) return
      e.stopPropagation()
      const swallow = (c: MouseEvent): void => {
        c.stopPropagation()
        c.preventDefault()
      }
      // Armed for this press's own click only. A cancelled press (a pan) never
      // clicks: it disarms at once. A lifted one gets a beat for its click,
      // which a finger's tap can deliver well after the release.
      const unarm = (): void => window.removeEventListener('click', swallow, true)
      const lifted = (): void => {
        stop()
        window.setTimeout(unarm, CLICK_GRACE_MS)
      }
      const cancelled = (): void => {
        stop()
        unarm()
      }
      const stop = (): void => {
        window.removeEventListener('pointerup', lifted, true)
        window.removeEventListener('pointercancel', cancelled, true)
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.addEventListener('pointerup', lifted, true)
      window.addEventListener('pointercancel', cancelled, true)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [foldable, folded])
  // A word from Sous or an error must be seen: they live in the box, so it opens.
  useEffect(() => {
    if ((error || sous) && foldable) promptFold.open()
  }, [error, sous, foldable])

  const face = to ? faceOf(to.id, to.name, crewRows, harness) : null
  // THE FACE FLIES LEFT (face-flip.ts): where the folded face last stood, and
  // the chip's face it becomes when the box opens; another agent pops in.
  const faceRef = useRef<HTMLButtonElement>(null)
  const lastFace = useRef<Box | null>(null)
  const chipFace = useRef<HTMLSpanElement>(null)
  const chipName = useRef<HTMLElement>(null)
  const seen = useRef<{ folded: boolean; id: string | null }>({ folded, id: to?.id ?? null })
  useLayoutEffect(() => {
    if (folded && faceRef.current) lastFace.current = faceRef.current.getBoundingClientRect()
  })
  useLayoutEffect(() => {
    const was = seen.current
    const id = to?.id ?? null
    seen.current = { folded, id }
    const el = chipFace.current
    if (folded || !el) return
    if (was.folded && lastFace.current) flyFace(el, lastFace.current, { box: formRef.current, rest: [chipName.current] })
    else if (was.id !== id) popFace(el)
  }, [folded, to?.id])
  /** The box can send: words, or a bare Enter where the agent's terminal is in sight. */
  const canSend = text.trim() !== '' || (to !== null && to.id === fullAgentId)
  const hold = dictation.ear
    ? {
        onHold: () => {
          if (!dictation.listening) dictation.toggle()
        },
        onHoldEnd: () => dictation.stop()
      }
    : {}
  const foldedFace = (
    <PromptFace
      buttonRef={faceRef}
      agent={face}
      harness={harness}
      mode="folded"
      draft={text !== ''}
      listening={dictation.listening}
      label={to ? `Reply to ${to.name}` : `New ${harness} agent`}
      title={to ? `Reply to ${to.name} · click, or press Enter` : `A new ${harness} agent · click, or press Enter`}
      onTap={() => {
        if (dictation.listening) dictation.stop()
        openBox()
      }}
      onHold={hold.onHold}
      onHoldEnd={
        hold.onHoldEnd &&
        (() => {
          hold.onHoldEnd()
          openBox()
        })
      }
    />
  )
  /** Closed, the box takes the focus back (the list had it: its 'Send to…' field). */
  const closeWho = (): void => {
    setWho(false)
    focusBox()
  }
  const picker = (() => {
    if (!who) return null
    const pickable = crewRows.map((r) => ({ ...faceOf(r.id, r.name, crewRows, harness), lastActivityAt: r.lastActivityAt }))
    // At the artifacts stop and in a browser's or a note's full view, their users lead.
    const first = usersInView({ dir: zoomDir, v: zoomV, full: zoomFull, item: zoomItem, artifacts })
    return (
      <WhoPicker
        rows={pickable}
        first={first}
        recentTitle={zoomFull === 'item' ? 'used it' : 'recent'}
        harnesses={harnesses}
        current={{ id: to?.id ?? null, harness }}
        onAgent={(id) => {
          if (!known(id)) return
          // Committed before the focus comes back, so the box's focus holds the picked agent.
          flushSync(() => {
            setReleased(null)
            // A hold on the box moves with the pick: the words go where it points.
            setHeld((h) => (h ? { id } : h))
            setPickedAgent(id)
            setWho(false)
          })
          focusBox()
        }}
        onNew={(name) => {
          flushSync(() => {
            setPickedAgent(null)
            if (viewed) letGo(viewed)
            setWho(false)
            takeHarness(name)
          })
          focusBox()
        }}
        onClose={closeWho}
      />
    )
  })()

  /** A harness taken for the new agent; its menu closes. */
  const takeHarness = (name: string): void => {
    picked.current = name
    setHarness(name)
    rememberHarness(name)
    setPicking(null)
  }
  const pick = (name: string): void => {
    takeHarness(name)
    focusBox()
  }

  return (
    <>
    {folded && place === 'bar' && faceSlot && createPortal(foldedFace, faceSlot)}
    {folded && place === 'corner' && createPortal(<div className="pf-corner">{foldedFace}</div>, document.body)}
    <form
      ref={formRef}
      className={`cr-prompt${to ? ' to-agent' : ' to-new'}${attach.attaching ? ' attaching' : ''}${hearing ? ' listening' : ''}${folded ? ' folded' : ''}`}
      // Esc on the box's buttons and the picker's rows (the input keeps its own):
      // the picker closes first, then the box folds; the zoom never sees it.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        if (who) {
          e.stopPropagation()
          return closeWho()
        }
        if (!foldable) return
        e.stopPropagation()
        promptFold.fold()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        if (dictation.listening) return
        submit()
      }}
    >
      {/* THE CHIP IS THE FACE (owner, 2026-11-04): the agent's own face and name,
          flown here from the bar's end (face-flip.ts); a tap chooses who. */}
      {to ? (
        <span className="cr-prompt-to pf-chip" title={`Prompts go to ${to.name}`}>
          <button
            type="button"
            className="pf-chip-who"
            aria-haspopup="listbox"
            aria-expanded={who}
            aria-label={`${to.name} · choose who the words go to`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (who ? closeWho() : setWho(true))}
          >
            <span className="pf-chip-face" ref={chipFace}>
              <InkAvatar id={to.id} preset={face?.preset ?? harness} orch={face?.orch ?? false} status={face?.status ?? 'idle'} weight="regular" />
            </span>
            <b ref={chipName}>{to.name}</b>
          </button>
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
            title="The harness the new agent runs — or open a shell"
            onClick={(e) => {
              const at = riseOver(e.currentTarget.getBoundingClientRect(), window.innerHeight, keyboardCoverNow(), 6, topBarBottom())
              setPicking((open) => (open ? null : at))
            }}
          >
            <span className="pf-chip-face pf-new" ref={chipFace}>
              <InkAvatar id={`new:${harness}`} preset={harness} status="idle" weight="regular" />
            </span>
            <span ref={chipName}>＋ {harness} ▾</span>
          </button>
          {picking && <HarnessMenu at={picking} harnesses={harnesses} harness={harness} onPick={pick} acts={acts} onDone={() => setPicking(null)} />}
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
            tune={offeredPick(launchTune, offer, gateway)}
            gateway={gateway}
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
        value={hearing ? withHeard(shown, dictation.heard) : shown}
        readOnly={hearing}
        placeholder={earSays(dictation) ?? (to ? 'Reply… · # a note or browser' : 'Describe a task…')}
        aria-label={to ? `Prompt ${to.name}` : 'Prompt for a new agent'}
        title="Paste or drop a screenshot: it goes into the prompt"
        autoComplete="off"
        disabled={busy}
        onPaste={attach.onPaste}
        onChange={(e) => {
          if (!hearing) write(withShownWords(text, e.target.value), (e.nativeEvent as InputEvent).isComposing === true)
        }}
        onCompositionEnd={(e) => {
          // The shown value carries the heard words while listening; they land once, from the ear.
          if (!hearing) write(withShownWords(text, e.currentTarget.value))
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
          // Enter with nothing to send is nothing: the face is the form's submit,
          // and its empty tap is the who-picker's, not the keyboard's.
          if (e.key === 'Enter' && !canSend) {
            e.preventDefault()
            return
          }
          // Backspace in a box with no words takes the last picture out, then lets go of the agent.
          if (e.key === 'Backspace' && !e.repeat && shown === '' && text !== '') {
            write(withoutLastPicture(text))
            return
          }
          if (e.key === 'Backspace' && !e.repeat && to && text === '') letGo(to.id)
          if (e.key === 'Escape') {
            // Esc closes the who-picker first, then folds the box.
            if (who) {
              setWho(false)
              return
            }
            e.currentTarget.blur()
            // Esc folds the box (its words stay, a dot on the face).
            if (foldable) promptFold.fold()
          }
        }}
      />
      {/* The tools after the chips: a row above the words on a phone, the
          keys wrapping onto a line of their own when it is short (owner,
          2026-11-03: "the arrows and ESC seem gone" from a swiped row;
          global-prompt.css · .cr-prompt-tools); in line on a wide screen. */}
      <span className="cr-prompt-tools">
      <ExtrasToggle shown={toolsShown} speaking={spoken.on} onToggle={toggleTools} />
      {browse.input}
      {toolsShown && (
        <VoiceBar key={to ? `voice:${to.id}` : 'voice:new'} terminalId={to?.id ?? null}>
          <PromptExtras
            canAttach={!to?.remote}
            attaching={attach.attaching}
            onPick={attach.pickFiles}
            onBrowse={browse.open}
            speaking={spoken.on}
            reading={spoken.reading}
            onSpeak={spoken.toggle}
          />
        </VoiceBar>
      )}
      </span>
      {/* Beside Send, out of the tools: on a phone the box's one row at rest is
          the chip, the words, 🎤 and Send (global-prompt.css · THE BOX FLOATS). */}
      {dictation.ear && (
        <button
          type="button"
          className={`cr-btn sm voice-mic${dictation.listening ? ' listening' : ''}`}
          title={dictation.listening ? 'Stop: the words go into the prompt' : dictation.ear === 'mac' ? 'Dictate into the prompt (or hold ⌘)' : 'Dictate into the prompt'}
          aria-label={dictation.listening ? 'Stop dictating' : 'Dictate'}
          aria-pressed={dictation.listening}
          // Keep the caret where it was: the words land in the draft either way.
          onMouseDown={(e) => e.preventDefault()}
          onClick={dictation.toggle}
        >
          <CrIcon name="mic" />
        </button>
      )}
      {/* Send, right of the mic (owner, 2026-11-04). */}
      <button type="submit" className="cr-btn sm primary" title={to ? 'Send (Enter)' : 'Make the agent (Enter)'} aria-label="Send" disabled={busy || dictation.listening || !canSend}>
        <CrIcon name="send" />
      </button>
      {picker}
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
      <PictureStrip
        pictures={picturesOfDraft(text)}
        className="cr-prompt-pics"
        onRemove={(picture) => picture.path && write(withoutPicture(text, picture.path))}
      />
      {dropOver && (
        <div className="attach-drop-hint cr-prompt-drop">
          <span>
            <CrIcon name="attach" /> {to?.remote ? 'ATTACHMENTS STAY HERE — THIS TEAM RUNS ELSEWHERE' : 'DROP TO ATTACH'}
          </span>
        </div>
      )}
    </form>
    </>
  )
}

/**
 * What the box's own placeholder says while an ear is open. The phone's ear
 * has no words until the Mac has heard them, so it says what it is doing —
 * IN the box: a note of its own took a row on a phone and moved every
 * button under the owner's thumb (owner, 2026-11-03).
 */
function earSays(dictation: { ear: string | null; phase: 'idle' | 'hearing' | 'closing' }): string | null {
  if (dictation.phase === 'idle') return null
  if (dictation.ear === 'phone') return dictation.phase === 'hearing' ? '● Recording… tap the mic to finish' : 'The Mac is listening…'
  return dictation.phase === 'hearing' ? 'Listening…' : null
}
