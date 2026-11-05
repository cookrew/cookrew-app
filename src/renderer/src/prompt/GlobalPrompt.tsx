import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
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
import { lastHarness, onHarnessPref, rememberHarness } from './harness-pref'
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
import { inputRefused, noteSent, takeRefused, WAKE_WINDOW_MS } from './input-refused'
import { launchRefusal } from './launch-gate'
import { boxPin, boxTargetId, heldAfter, mentionTarget, pickAfterMove, pickNow, promptTargetOf, releaseAfter, zoomMoveKey, type Pick, type Release } from './prompt-target'
import { sendToAgent } from './send'
import { useDictation } from './use-dictation'
import { usePromptAttach } from './use-prompt-attach'
import { useDropOn, useDropZone } from './drop-zone'
import { ExtrasToggle, PromptExtras, useFilePicker } from './PromptExtras'
import { extrasShown, rememberExtras, toolsOpen } from './extras-pref'
import { useSpokenReplies } from './use-spoken-replies'
import { PictureStrip, picturesOfDraft } from '../pictures/PictureStrip'
import { shownWords, withoutLastPicture, withoutPicture, withShownWords } from './draft-pictures'
import { keyboardCoverNow, riseOver, type RiseAnchor, topBarBottom } from './rise-anchor'
import { useCrewContext } from '../stage/crew-rows'
import { inkStatusOfRow } from '../zoom/ink-status'
import type { AgentRow } from '../agent-rows'
import { boxFold, facePlace, promptFold, usePromptOpen, usePromptWho, type FacePlace } from './prompt-fold'
import { flyFace, popFace, riseBox, type Box } from './face-flip'
import { expectKeyboard, keyboardLeaving, takesKeys } from '../keyboard-expect'
import { barCard, useBarAgent } from '../zoom/bar-pick'
import { fliesBack, flyBack, snapshotBox, stageFlyer, stageGhost, type FoldSnapshot } from './fold-flight'
import { SentToast, pressKey, useSentToast } from './SentToast'
import { useFaceSlot } from './face-slot'
import { enterOpensBox, pasteOpensBox } from './enter-opens'
import { listenFoldPress } from './fold-press'
import { sendPlan } from './send-plan'
import { pastedImages } from './prompt-attach'
import { latestUser, usersInView } from './item-user'
import { PromptFace, RemoteMark, type FaceAgent } from './PromptFace'
import { promptPlaceholder, withItemRef, wordsStop, type WordsStop } from './prompt-words'
import { ItemRefChip } from './ItemRefChip'
import { InkAvatar } from '../zoom/InkAvatar'
import { WhoPicker } from './WhoPicker'
import { WaitChoices } from './WaitChoices'
import { useWaitAnswer, type WaitAnswering } from './wait-answer'
import { promptBox } from './box-focus'
import { firstFolder } from '../first-run/first-folder'
import { useFirstRunStage, useFirstTask } from '../first-run/first-run-state'
import { FIRST_SCREEN_COPY, exampleName } from '../../../shared/first-run-copy'
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
 * Folded, the ＋ face takes a dropped file and a pasted picture: the box opens
 * with it attached. Back on the phone takes the Esc order (back-guard.ts).
 *
 * THE BOX FOLLOWS WHAT IT MADE (owner task, 2026-11-04): after a prompt makes
 * an agent, the chip becomes the new agent's face and name (it pops in), so
 * the next words are a follow-up, until the zoom's next deliberate move, as a
 * pick (prompt-target.ts · pickNow).
 *
 * VOICE lands here too, and only here (use-dictation.ts): the mic, or ⌘
 * held, puts the words into the draft to be read and sent, for an agent or
 * for a new one. A sentence addressed to Sous ("Sous, switch to …") goes to
 * Sous instead; if it was no command after all, it lands in the draft.
 *
 * THE FIRST SCREEN IS THIS BOX (first-run/FirstScreen.tsx): held open, asking
 * the screen's question, and it adds three things to a send: the folder the
 * agent will work in, main holding the words until the agent can take them (a
 * new Claude opens on its sign-in), and the lead: this agent stands in for the
 * Conductor a new Mac no longer boots. The rest is the ordinary new agent.
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
  /** The active workspace's name: the placeholder names it at the outer stops. */
  workspaceName?: string | null
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
/** The stop the box's words are read at (prompt-words.ts): what its placeholder says. */
function useWordsStop(): WordsStop {
  return useSyncExternalStore(zoomStore.subscribe, () => wordsStop(zoomStore.get()), () => 'crew')
}

const NO_ROWS: readonly AgentRow[] = []
const NO_IDS: readonly string[] = []

/** An agent's face as its crew row draws it; a plain one before the crew knows it. */
function faceOf(id: string, name: string, rows: readonly AgentRow[], fallbackPreset: string): FaceAgent {
  const row = rows.find((r) => r.id === id)
  return row
    ? { id, name: row.name, preset: row.preset, orch: row.orch, status: inkStatusOfRow(row.phase, row.unread), failure: row.failure ?? null }
    : { id, name, preset: fallbackPreset, orch: false, status: 'idle' }
}

/** The zoom's deliberate moves, as one key (zoomMoveKey): a release lasts until the next one. */
function useZoomMoveKey(): string {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomMoveKey(zoomStore.get()), () => '')
}

export function GlobalPrompt({ fullAgentId, agents, harnesses, nodes, orch = false, artifacts = NO_ARTIFACTS, acts, workspaceName = null }: GlobalPromptProps): React.JSX.Element {
  const cardAgent = useCardAgent()
  const firstStage = useFirstRunStage()
  const firstRecord = useFirstTask()
  // The first screen's box: once the agent has the task this is the ordinary box.
  const firstTask = firstStage === 'task' && firstRecord?.state !== 'sent'
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
  // An agent's card opened from the bar's group selects it (zoom/bar-pick.ts):
  // the latest choice, so it stands before a card the zoom still holds.
  const barAgent = useBarAgent()
  const viewed = fullAgentId ?? barAgent ?? cardAgent ?? itemUser.current.id
  const stop = useWordsStop()
  // AN ITEM NOBODY HAS USED rides the words as a #ref chip (owner design,
  // 2026-11-04): the new agent is made with it. × leaves it out until the view moves.
  const [itemLeftOut, setItemLeftOut] = useState<string | null>(null)
  const viewedItem = itemKey && itemUser.current.id === null ? (artifacts.find((a) => a.id === zoomItem) ?? null) : null
  const attachedItem = viewedItem && itemLeftOut !== itemKey ? viewedItem : null
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
  // The who-picker's pick, or the agent a prompt just made, stands in for the
  // view's agent until the same move (prompt-target.ts · pickNow).
  const [standIn, setStandIn] = useState<Pick | null>(null)
  const pickedAgent = pickNow(standIn, moveKey)
  useEffect(() => {
    setReleased(null)
    // A move ends it for good: back at the same place (a card closed and
    // opened again) the old pick does not come back.
    setStandIn((s) => pickAfterMove(s, moveKey))
  }, [moveKey])
  // A bar group's agent card is a deliberate choice too: an older pick or let-go does not stand over it.
  useEffect(() => {
    if (barAgent === null) return
    setReleased(null)
    setStandIn(null)
  }, [barAgent])
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
  }, [offered, firstTask])
  // Chosen elsewhere (the tool check, a saved endpoint): the box follows.
  useEffect(() => onHarnessPref(() => setHarness(lastHarness(harnesses))), [offered]) // eslint-disable-line react-hooks/exhaustive-deps
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
    if (firstTask) {
      // No tool, no card: a card would die, and the words are safest where they are.
      const blocked = await cookrew().firstRunCanStart?.(harness)
      if (blocked) {
        setBusy(false)
        return setError(blocked)
      }
      const folder = await firstFolder.ready()
      if (folder !== 'ready') {
        setBusy(false)
        if (folder === 'failed') setError(FIRST_SCREEN_COPY.FOLDER_FAILED)
        return
      }
    }
    const { words: prompt, refs } = said(withItemRef(raw, attachedItem, artifacts))
    const tune = offeredPick(launchTune, offer, gateway)
    // Named from the words typed, not from the item riding ahead of them. An example has a name of its own.
    const example = firstTask ? exampleName(raw) : null
    const choice = { name: example ?? nameFromPrompt(said(raw).words), preset: harness, orch: orch || firstTask, prompt, patient: firstTask, autoName: true, tune }
    const made = await makeAgent(cookrew(), example ? { ...choice, autoName: false } : choice, nodes)
    setBusy(false)
    if (!made.ok) return setError(made.error)
    if (made.id) {
      wireRefs(made.id, refs)
      // The box follows it: the next words are a follow-up. Keyed to where the
      // make left the zoom (its card), so its next deliberate move ends it.
      setReleased(null)
      setStandIn({ id: made.id, at: zoomMoveKey(zoomStore.get()) })
      // It could not start: the card says why, and the words wait in its box.
      const refusal = await launchRefusal(made.id)
      if (refusal) {
        setText('')
        setDraft(draftKey(made.id), raw)
        setError(refusal)
        return
      }
    }
    // A first task has not arrived yet: the waiting screen says how it is going.
    if (!firstTask) toast.leave(`New ${harness} agent`, shownWords(raw))
    setText('')
  }

  // SEND (SentToast.tsx): the key dips as the words go, and they leave as a toast over the box.
  const sendRef = useRef<HTMLButtonElement>(null)
  const toast = useSentToast()
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? 'the agent'

  // What Enter or Send does with the words (send-plan.ts): nothing in an empty box.
  const plan = sendPlan({ text, to, fullAgentId, mention: mentionTarget(text, agents) })
  /** The wait on show (declared below, with the rest of it). */
  const waitRef = useRef<WaitAnswering | null>(null)
  // The Mac would not take them: the words come back, and the box says why.
  useEffect(
    () =>
      inputRefused.subscribe((id, data) => {
        const back = takeRefused(id, data, Date.now())
        if (!back) return
        if (back.words && getDraft(back.box) === '') setDraft(back.box, back.words)
        setError(`Not sent: ${agents.find((a) => a.id === id)?.name ?? 'the agent'} is still on a task it was given.`)
      }),
    [agents]
  )
  // Words main could not deliver after all (the agent died on waking): they come back.
  useEffect(
    () =>
      cookrew().onEvent?.((raw) => {
        const event = raw as { type?: string; entityId?: string; details?: string }
        if (event.type !== 'terminal.input-lost' || !event.entityId) return
        const back = takeRefused(event.entityId, '\r', Date.now(), WAKE_WINDOW_MS)
        if (!back) return
        if (back.words && getDraft(back.box) === '') setDraft(back.box, back.words)
        setError(`Not sent: ${event.details ?? 'the agent would not start.'}`)
      }),
    []
  )
  const checkingLaunch = useRef(false)
  /** An offline agent is asked first (launch-gate.ts): what cannot start must not take the words. */
  const submit = (): void => {
    setError(null)
    const target = plan.kind === 'agent' || plan.kind === 'mention' ? plan.id : null
    const offline = target !== null && crewRows.find((row) => row.id === target)?.phase === 'offline'
    if (!offline) return deliver()
    if (checkingLaunch.current) return
    checkingLaunch.current = true
    void launchRefusal(target)
      // The latest render's: words typed during the check are part of the send.
      .then((refusal) => (refusal ? setError(refusal) : deliverRef.current()))
      .finally(() => {
        checkingLaunch.current = false
      })
  }
  const deliverRef = useRef<() => void>(() => undefined)
  const deliver = (): void => {
    // The key dips only when its press sends something.
    if (plan.kind !== 'none' && !(plan.kind === 'new' && busy)) pressKey(sendRef.current)
    if (plan.kind === 'mention') {
      // "@Other …" goes to Other, whoever the box is carrying.
      const out = said(withItemRef(plan.words, attachedItem, artifacts))
      noteSent({ id: plan.id, box: draftKey(to?.id ?? null), words: text, at: Date.now() })
      sendToAgent(plan.id, out.words)
      wireRefs(plan.id, out.refs)
      toast.leave(nameOf(plan.id), shownWords(plan.words))
      // Enter took whatever sat in Other's line along with the words.
      endLine(plan.id)
      setText('')
      return
    }
    if (plan.kind === 'agent') {
      // A bare Enter only where its terminal is in sight (send-plan.ts).
      const out = said(withItemRef(plan.words, attachedItem, artifacts))
      // A menu is on the screen: words typed at it would land as keys, and
      // their Enter would pick whatever row the cursor is on.
      const menu = waitRef.current
      if (menu?.menu && out.words.trim()) {
        if (!menu.wordsRow) return setError('Answer the menu first: a row, or Esc.')
        // Cleared now, not when it lands: a second Enter must find nothing to send.
        setText('')
        menu.sendWords(out.words)
        wireRefs(plan.id, out.refs)
        toast.leave(nameOf(plan.id), shownWords(plan.words))
        return
      }
      noteSent({ id: plan.id, box: draftKey(to?.id ?? null), words: text, at: Date.now() })
      submitLine(plan.id, out.words.trim() ? out.words : '')
      wireRefs(plan.id, out.refs)
      toast.leave(nameOf(plan.id), shownWords(plan.words))
      return
    }
    if (plan.kind === 'new' && !busy) void makeNew(plan.words)
  }
  deliverRef.current = deliver

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
  /** How far the box rises for the keyboard the open under way expects (keyboard-expect.ts). */
  const keyboardRise = useRef(0)
  /** The keyboard up, if any, is the box's: it goes with the box's focus, and another field's does not. */
  const typedHere = useRef(false)
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
  // THE WAIT CHOICE BOX (WaitChoices.tsx): the menu the agent waits on, over
  // the box; its Esc row (and a bar card's) hands over to typing here.
  const wait = useWaitAnswer(to?.id ?? null, focusBox)
  waitRef.current = wait
  useEffect(() => promptBox.register(() => inputRef.current?.focus()), [])

  // THE FOLD (prompt-fold.ts): the face stands on the zoom's bar at its stops,
  // alone in a corner over a browser or a note; an agent's full view keeps the
  // box open. With no bar mounted (the board), the box never folds.
  const faceSlot = useFaceSlot()
  const place = facePlace(zoomFull)
  const open = usePromptOpen()
  // An agent in the box holds it open, in place of the bar (prompt-fold.ts · boxFold).
  const { canFold: foldable, folded, overBar } = boxFold({ place, slot: faceSlot !== null, pinned: to !== null || firstTask, open })
  // The who-picker lives in the fold store: the zoom's Esc and the phone's
  // back close it first (prompt-fold.ts · takeBack).
  const who = usePromptWho()
  const setWho = promptFold.setPicker
  useEffect(() => setWho(false), [to?.id, folded, setWho])
  // The picker is for an empty box: words typed with it open close it, so a
  // pick never lands while words hold the box on someone else.
  useEffect(() => {
    if (text.trim() !== '') setWho(false)
  }, [text, setWho])
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
  // Where the box cannot fold (an agent in it, its full view) it is not left
  // open behind: back at the stops it starts folded (prompt-fold.ts · setFoldable).
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
    // The keyboard this focus raises is published first: the flight measures where the box ends up.
    keyboardRise.current = expectKeyboard()
    flushSync(() => promptFold.open())
    inputRef.current?.focus()
    // Not taken by a flight (the box was open already): it rises on its own.
    riseBox(formRef.current, keyboardRise.current)
    keyboardRise.current = 0
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
  // A primary press anywhere else folds it; on the canvas that is all it does
  // (fold-press.ts).
  useEffect(() => {
    if (!foldable || folded) return
    return listenFoldPress(window, {
      onFold: () => {
        setPicking(null)
        promptFold.fold()
      }
    })
  }, [foldable, folded])
  // A word from Sous or an error must be seen: they live in the box, so it opens.
  useEffect(() => {
    if ((error || sous) && foldable) promptFold.open()
  }, [error, sous, foldable])

  // A PICTURE PASTED WITH THE BOX FOLDED (desktop ⌘V, no field taking it)
  // opens the box with the picture attached (enter-opens.ts · pasteOpensBox).
  const attachRef = useRef(attach)
  attachRef.current = attach
  useEffect(() => {
    if (!folded) return
    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented || !pasteOpensBox(e.target instanceof Element ? e.target : null)) return
      if (document.querySelector('[aria-modal="true"]')) return
      const images = pastedImages(e.clipboardData)
      if (images.length === 0) return
      e.preventDefault()
      openBox()
      attachRef.current.takeImages(images)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded])

  const face = to ? faceOf(to.id, to.name, crewRows, harness) : null
  // THE FACE FLIES LEFT (face-flip.ts): where the folded face last stood, and
  // the chip's face it becomes when the box opens; another agent pops in.
  const faceRef = useRef<HTMLButtonElement | null>(null)
  // A FILE DROPPED ON THE FOLDED FACE (desktop) opens the box with it
  // attached; the drop cue shows over the face while the file hovers it.
  const [faceEl, setFaceEl] = useState<HTMLButtonElement | null>(null)
  const faceButton = useCallback((node: HTMLButtonElement | null) => {
    faceRef.current = node
    setFaceEl(node)
  }, [])
  const faceDrop = useDropOn(folded ? faceEl : null, (files) => {
    openBox()
    attachRef.current.dropFiles(files)
  })
  const lastFace = useRef<Box | null>(null)
  const chipFace = useRef<HTMLSpanElement>(null)
  const chipName = useRef<HTMLElement>(null)
  // The face's place is there: the bar's slot mounted (the zoom mounts after the dock), or the corner.
  const placed = place === 'corner' || (place === 'bar' && faceSlot !== null)
  const seen = useRef<{ folded: boolean; id: string | null; place: FacePlace; placed: boolean }>({ folded, id: to?.id ?? null, place, placed })
  useLayoutEffect(() => {
    if (folded && faceRef.current) lastFace.current = faceRef.current.getBoundingClientRect()
  })
  // Read in the render that changes the fold, while the page still shows the
  // last one (its commit unmounts the face, or hides the box): the folded face
  // where it is now, mid-flight or at rest, for the open; the open box and its
  // chip's face for the fold's flight back (fold-flight.ts).
  const foldFrom = useRef<FoldSnapshot | null>(null)
  if (!folded && seen.current.folded && faceRef.current) lastFace.current = faceRef.current.getBoundingClientRect()
  if (fliesBack(seen.current, { folded, place, placed })) foldFrom.current = snapshotBox(formRef.current, chipFace.current)
  /** The fold's flight under way: stopped by a re-open, or the box going away. */
  const landing = useRef<(() => void) | null>(null)
  useEffect(() => () => landing.current?.(), [])
  useLayoutEffect(() => {
    const was = seen.current
    const id = to?.id ?? null
    seen.current = { folded, id, place, placed }
    const snap = foldFrom.current
    foldFrom.current = null
    landing.current?.()
    landing.current = null
    if (folded) {
      const face = faceRef.current
      // Read before it is told: the box's focus goes with the fold, and its keyboard with it.
      const cover = typedHere.current ? keyboardCoverNow() : 0
      if (typedHere.current) keyboardLeaving()
      typedHere.current = false
      if (!snap || !face || !fliesBack(was, { folded, place, placed })) return
      const ghost = formRef.current ? stageGhost(snap, formRef.current) : null
      landing.current = flyBack(face, snap, { dot: face.querySelector<HTMLElement>('.pf-dot'), bar: face.closest<HTMLElement>('.zv-controls'), page: document.body, cover, flyer: place === 'bar' ? stageFlyer(face, ghost) : null })
      return
    }
    const el = chipFace.current
    if (!el) return
    // Opened from a bar group's face, it flies from that face; else from the folded one.
    const from = barCard.takeFrom() ?? lastFace.current
    if (was.folded && from) {
      flyFace(el, from, { box: formRef.current, rest: [chipName.current], rise: keyboardRise.current })
      keyboardRise.current = 0
    } else if (was.id !== id) popFace(el)
  }, [folded, to?.id, place, placed])
  /** The box can send: words, or a bare Enter where the agent's terminal is in sight (send-plan.ts). */
  const canSend = plan.kind !== 'none'
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
      buttonRef={faceButton}
      agent={face}
      harness={harness}
      mode="folded"
      draft={text !== ''}
      dropping={faceDrop}
      remote={to?.remote ?? false}
      listening={dictation.listening}
      label={to ? `Reply to ${to.name}${to.remote ? ' · runs elsewhere' : ''}` : `New ${harness} agent`}
      tip={
        <>
          {to ? 'Reply to' : 'New'} <b>{to ? to.name : harness}</b>
          {to ? '' : ' agent'} · click, or press <kbd>⏎</kbd>
        </>
      }
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
            setStandIn({ id, at: moveKey })
            setWho(false)
          })
          focusBox()
        }}
        onNew={(name) => {
          flushSync(() => {
            setStandIn(null)
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
        if (promptFold.backFirst()) e.stopPropagation()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        if (dictation.listening) return
        submit()
      }}
    >
      {/* Before the box in the focus order; a bar group's card for the same agent carries the rows instead. */}
      {to && face && !folded && barAgent !== to.id && <WaitChoices face={{ id: to.id, name: to.name, preset: face.preset, orch: face.orch }} wait={wait} />}
      {/* THE CHIP IS THE FACE (owner, 2026-11-04): the agent's own face and name,
          flown here from the bar's end (face-flip.ts); a tap chooses who. */}
      {to ? (
        <span className="cr-prompt-to pf-chip" title={`Prompts go to ${to.name}${to.remote ? ' · it runs elsewhere' : ''}`}>
          <button
            type="button"
            className="pf-chip-who"
            aria-haspopup="listbox"
            aria-expanded={who}
            aria-label={`${to.name}${to.remote ? ' (runs elsewhere)' : ''} · choose who the words go to`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (who ? closeWho() : setWho(true))}
          >
            <span className="pf-chip-face" ref={chipFace}>
              <InkAvatar id={to.id} preset={face?.preset ?? harness} orch={face?.orch ?? false} status={face?.status ?? 'idle'} weight="regular" />
              {to.remote && <RemoteMark />}
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
            title="What the new agent runs — or open a shell"
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
        placeholder={earSays(dictation) ?? promptPlaceholder({ agent: to && face, stop, workspace: workspaceName, item: attachedItem, asks: waitingOnYou && !wait.menu, answers: wait.wordsRow, first: firstTask })}
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
        onFocus={() => {
          setHeld({ id: to?.id ?? null })
          typedHere.current = true
          // A tap in an open box raises the keyboard too (openBox has already expected its own).
          riseBox(formRef.current, expectKeyboard())
        }}
        onBlur={(e) => {
          setHeld(null)
          if (takesKeys(e.relatedTarget)) typedHere.current = false
          else keyboardLeaving()
        }}
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
          // An empty box answers the menu the agent waits on: a row's key, or Esc (WaitChoices.tsx).
          // Never a shifted letter (words start with one) nor an IME's keystroke (229).
          if (!who && shown === '' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !(wait.wordsRow && e.key !== 'Escape') && wait.key(e.key)) {
            e.preventDefault()
            return
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
      {/* THE TRAY (task "Phone tray chips float", 2026-11-04): model · effort,
          the item riding the words and the tools (^, 📎, 🔊, the agent's keys).
          On a phone a see-through row of chips of its own, floating 8px over
          the pill and swiped sideways (global-prompt.css · .cr-prompt-tray);
          on a wide screen no box at all, its chips in the box's one line.
          One pill each, the ^ after the keys (owner, 2026-11-04: chip · model
          · words · 📎 🔊 · keys · ^ · mic · Send; a phone draws it after model
          · effort, global-prompt.css · THE TRAY'S TOOLS, ONE FORM). */}
      <div className="cr-prompt-tray">
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
        {attachedItem && itemKey && <ItemRefChip item={attachedItem} onRemove={() => setItemLeftOut(itemKey)} />}
      <span className="cr-prompt-tools">
      {browse.input}
      {toolsShown && (
        <VoiceBar key={to ? `voice:${to.id}` : 'voice:new'} terminalId={to?.id ?? null} menuKey={wait.trayKey}>
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
      <ExtrasToggle shown={toolsShown} speaking={spoken.on} onToggle={toggleTools} />
      </span>
      </div>
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
      <button type="submit" className="cr-btn sm primary" ref={sendRef} title={to ? 'Send (Enter)' : 'Make the agent (Enter)'} aria-label="Send" disabled={busy || dictation.listening || !canSend}>
        <CrIcon name="send" />
      </button>
      {picker}
      <SentToast sent={toast.sent} />
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
