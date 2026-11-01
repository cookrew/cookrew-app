import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AttachPanel, AttachTabs } from './AttachPanel'
import { attachView, useAttachView } from './attach-view'
import { NO_ATTACHMENTS, SideTabsContext, TerminalAttachmentsContext } from './terminal-attachments'
import './transcript-paper.css'
import { Terminal } from '@xterm/xterm'
import { createPortal } from 'react-dom'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { IClipboardProvider } from '@xterm/addon-clipboard'
import { readClipboardText, writeClipboardText } from './clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalNodeData } from '../../shared/model'
import type { TerminalActivity, TurnPhase } from '../../shared/turn'
import type { LodLayout, ScreenRect } from './zoom-lod'
import { useActivity } from './activity-thumb-store'
import { useCanvasUi } from './canvas-ui'
import { cookrew, isRemoteMode } from './api'
import { doorStateSentence, type DoorTranscriptState } from '../../shared/door-transcript-state'
import { CheckpointTimeline } from './CheckpointTimeline'
import { TranscriptView, type ActiveBlock, type TranscriptHandle } from './TranscriptView'
import { tailClipRows } from './transcript'
import { checkpointRowTitle } from './stream/stream-rows'
import { streamPagerOf } from './stream/stream-pager'
import { useStream } from './stream/use-stream'
import { useTitleMode } from './checkpoint-sync'
import { attachFilesToTerminal, pasteClipboardImages } from './AttachButton'
import { handleTerminalPaste } from './terminal-paste'
import { terminalKeyIntent } from './terminal-key-intent'
import { pasteFromClipboard } from './terminal-clipboard'
import { registerTerminalPaste } from './terminal-paste-bus'
import { attachImeBridge } from './ime-input-bridge'
import { attachPhoneField, muteXtermFieldSends } from './textarea-pad'
import { phoneGlyphs } from './phone-glyphs'
import { CrIcon } from './icons'
import { TranslateButton } from './TranslateButton'
import { languageByCode } from '../../shared/translate'
import { useCheckpointTranslation } from './use-checkpoint-translation'
import { AgentAvatar, StatusCoin } from './nodes/AgentAvatar'
import { TranscriptFaceContext } from './transcript-face'
import { LOOK_LABEL, LOOK_TITLE, isRecordLook, nextLook, useTranscriptLook, type TranscriptLook } from './transcript-look'
import { installLocalScroll, type LocalScroll } from './live-scroll'
import { createCurtain, domCurtainDeps, subRowShift } from './live-curtain'
import { installLiveSheet, type LiveSheet } from './live-sheet'
import { closeZoomMenu, tuneSummary, useZoomSlots } from './zoom-bar'
import { TuneMenu } from './nodes/TuneMenu'
import { useAgentTuning } from './nodes/use-agent-tuning'
import { useCardRoute } from './nodes/use-card-route'
import { routeDialAllowed, routeDialInput } from '../../shared/route-view'
import { isNight, useNight } from './color-scheme'
import { paperCursor } from './paper-cursor'
import { createSizeOwner, openedAt, SETTLE_CHECK_MS, tookOthers, type PaneSize } from './pane-size'
import { lastUserInputAt } from './user-input'
import { createTurnRedraw } from './turn-redraw'

/**
 * PAPER, not phosphor (2026-10-30): the live terminal is the app's own cream
 * and ink, like the transcript above it. A light ANSI palette — white and
 * bright white are greys and ink, or they would vanish — and a contrast floor
 * (minimumContrastRatio below) for the truecolor a dark-themed TUI still sends.
 */
const PAPER_THEME = {
  background: '#FFFEF5',
  foreground: '#2D2A20',
  cursor: '#2D2A20',
  cursorAccent: '#FFFEF5',
  selectionBackground: '#FFF3AD',
  black: '#2D2A20',
  red: '#B91C1C',
  green: '#15803D',
  yellow: '#A16207',
  blue: '#1D4ED8',
  magenta: '#A21CAF',
  cyan: '#0E7490',
  white: '#78716C',
  brightBlack: '#78716C',
  brightRed: '#DC2626',
  brightGreen: '#16A34A',
  brightYellow: '#CA8A04',
  brightBlue: '#2563EB',
  brightMagenta: '#C026D3',
  brightCyan: '#0891B2',
  brightWhite: '#2D2A20'
}

/**
 * The same paper at night (color-scheme.ts, night.css): the companion in a
 * phone's dark mode. Ground and ink are the night tokens; the colours are the
 * light steps of the palette, so they read on the dark ground.
 */
const NIGHT_THEME = {
  background: '#1D1A14',
  foreground: '#ECE5D3',
  cursor: '#ECE5D3',
  cursorAccent: '#1D1A14',
  selectionBackground: '#3B3212',
  black: '#6F6859',
  red: '#F87171',
  green: '#4ADE80',
  yellow: '#FACC15',
  blue: '#93C5FD',
  magenta: '#F0ABFC',
  cyan: '#67E8F9',
  white: '#A19887',
  brightBlack: '#A19887',
  brightRed: '#FCA5A5',
  brightGreen: '#86EFAC',
  brightYellow: '#FDE047',
  brightBlue: '#BFDBFE',
  brightMagenta: '#F5D0FE',
  brightCyan: '#A5F3FC',
  brightWhite: '#ECE5D3'
}

/**
 * Full views for terminal cards under semantic zoom: whenever a terminal
 * card covers enough of the stage (zoomed in by click or by hand), the live
 * xterm mounts in an overlay aligned to the card's screen rect and fades in
 * over the thumbnail. Zooming back out unmounts it — the PTY itself lives
 * in the main process, so nothing is lost between mounts.
 */
/** Menu name for a code, degrading to the code itself rather than to blank. */
function languageName(code: string | null): string {
  if (code === null) return 'another language'
  return languageByCode(code)?.name ?? code
}

/**
 * Memoised: the host (LodOverlays) re-renders on every viewport frame, and
 * this layer only has work to do when the arbitration result changes — which
 * useLodLayout guarantees by handing back the same `lod` object until it does.
 */
/** The mount kick waits until the terminal's box has been still this long. */
const MOUNT_KICK_SETTLE_MS = 400
/** ...but only while opening: a box change later is a resize, refitted as usual. */
const MOUNT_SETTLE_WINDOW_MS = 3000

export const TerminalOverlayLayer = memo(function TerminalOverlayLayer({
  terminals,
  lod,
  onPrimaryChange
}: {
  terminals: TerminalNodeData[]
  /** SHARED overlay arbitration (App-owned, spans terminals + browsers). */
  lod: LodLayout
  /** Reports the zoomed-in terminal (most-covered active) — null on canvas. */
  onPrimaryChange?: (id: string | null) => void
}): React.JSX.Element {
  const { activeIds, rects, primaryId } = lod
  // The dock composer only follows TERMINALS: when a browser wins the
  // shared arbitration, there is no composer target.
  const primaryTerminal =
    primaryId !== null && terminals.some((t) => t.id === primaryId) ? primaryId : null
  useEffect(() => {
    onPrimaryChange?.(primaryTerminal)
  }, [primaryTerminal, onPrimaryChange])
  return (
    <>
      {terminals
        .filter((t) => activeIds.has(t.id) && rects[t.id])
        .map((t) => (
          <TerminalOverlayFor
            key={t.id}
            node={t}
            rect={rects[t.id]}
            // Nothing primary (a browser won): the first terminal holds the bar.
            primary={primaryTerminal !== null ? t.id === primaryTerminal : t === terminals.find((x) => activeIds.has(x.id) && rects[x.id])}
          />
        ))}
    </>
  )
})

/** The overlay with ITS card's activity — a per-id subscription, not App's map. */
function TerminalOverlayFor({ node, rect, primary }: { node: TerminalNodeData; rect: ScreenRect; primary: boolean }): React.JSX.Element {
  const activity = useActivity(node.id)
  return <TerminalOverlay node={node} activity={activity} rect={rect} primary={primary} />
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The header line carries the agent's live status, not its name. */
/**
 * When a served session was admitted, said the way a person would.
 *
 * "today 09:14" while it is today, then the date — a bare timestamp on a
 * three-day-old session reads as if it just happened.
 */
function openedLabel(at: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  return sameDay
    ? `today ${time}`
    : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

const PHASE_CHIP: Record<TurnPhase, { label: string; cls: string }> = {
  idle: { label: 'READY', cls: '' },
  thinking: { label: 'WORKING', cls: ' busy' },
  waiting: { label: 'NEEDS ATTENTION', cls: ' attention' },
  replied: { label: 'CHECKPOINT SAVED', cls: ' done' }
}

function TerminalOverlay({
  node,
  activity,
  rect,
  primary = true
}: {
  node: TerminalNodeData
  activity: TerminalActivity | undefined
  rect: ScreenRect
  /**
   * The zoomed-in one (most covered) when several are mounted: only it puts
   * its switch on the bar and its rows in ⋯, or two cards would share one bar.
   */
  primary?: boolean
}): React.JSX.Element {
  const { zoomBack, requestClose } = useCanvasUi()
  const phase = activity?.phase ?? 'idle'
  // This terminal's own browsers and notes (canvas wiring), and the one open
  // in the lower half, if any.
  const attachments = useContext(TerminalAttachmentsContext).get(node.id) ?? NO_ATTACHMENTS
  const sideTabs = useContext(SideTabsContext)
  const openView = useAttachView()
  const openItem =
    openView !== null && openView.terminalId === node.id
      ? (attachments.find((a) => a.node.id === openView.itemId) ?? null)
      : null
  // Unwired or deleted while open: nothing left to show.
  useEffect(() => {
    if (openView !== null && openView.terminalId === node.id && openItem === null) attachView.close(node.id)
  }, [openView, openItem, node.id])
  // Leaving the card closes what it had open; the browser goes back to its own card.
  useEffect(() => () => attachView.close(node.id), [node.id])
  const [tailReady, setTailReady] = useState(false)
  const metadataReady = tailReady
  /**
   * AN IMPORTED CARD: a line into a session at someone else's app. Same rail,
   * same pager, same preview — its record is read from the door — but nothing
   * here may rewrite that record (no fork, rewind, role, attach), so those are
   * absent rather than rendered dead (remote-card parity §3, P11).
   */
  const remote = node.servedSession != null
  const containerRef = useRef<HTMLDivElement>(null)
  /**
   * The live layer's scroll position is TMUX's, not xterm's. The mirror
   * replays the current frame only; the scrollback lives in the pane, and a
   * wheel over the terminal drives tmux copy-mode through the mouse
   * sequences tmux turned on. The tracker reports where that is (scrollRow =
   * lines above the bottom, scrollBase = history size) with every activity
   * push; read through a ref so the wheel handler sees the newest reading.
   */
  const activityRef = useRef(activity)
  activityRef.current = activity
  // A widen mid-turn is redrawn when the turn ends (turn-redraw.ts); the
  // terminal effect below fills in the kick and the ownership test.
  const turnRedraw = useRef(createTurnRedraw())
  const kickRef = useRef<(() => void) | null>(null)
  const ownsRef = useRef<() => boolean>(() => false)
  // Drag-in attachments: dragenter/leave bubble from every child of the
  // overlay, so a plain boolean would flicker — count enters vs leaves.
  const [dropReady, setDropReady] = useState(false)
  const dragDepth = useRef(0)
  // Read by the key handler below through a ref so the xterm (created once
  // per node) always sees the latest agent detection from activity events.
  const agentRef = useRef(false)
  agentRef.current = activity?.agent ?? node.preset !== 'Shell'

  const [titleMode, toggleTitleMode] = useTitleMode()

  /**
   * THE ONE STREAM. Rail, drawer, pager and preview all read this — the
   * design's own line for T3. What it replaces, on this component alone: a
   * full /trace/index read, a /trace/markers read, a delta re-read keyed on
   * the PTY's turn count, a second delta on the file-watch nudge, and a
   * mergeCheckpointRows join over a ledger that was already being passed in
   * empty. Five reads and a join, for one listing.
   *
   * The boundary markers are DERIVED from the rows (markersOfIndex) rather
   * than fetched: a compaction is a fact the stream carries on the row after
   * it, so the second fetch had nothing left to tell us.
   */
  const stream = useStream(node.id)
  const rows = stream.rows
  const traceMarkers = stream.markers
  // The drawer's windows, named by identity (stream-pager.ts). Rebuilt when
  // the index moves, because that is what resolves an ordinal to a cursor.
  // Memoised on the pieces the pager READS, not on the handle: `stream` is a
  // fresh object every render, so keying on it would hand the drawer a new
  // pager per frame — and the pager is what the drawer's coalescing
  // single-flight is built from, so a rapid second far-jump would be dropped.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pager = useMemo(
    () => streamPagerOf(stream),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stream.index, stream.total, stream.blocksAround, stream.blocksAfter]
  )

  // WHY the rail is empty or stale, for a remote card — a named state from
  // the door, rendered as a sentence in the session strip (P10). Re-read
  // whenever the stream moves: a state change is part of the door poll's
  // fingerprint, and the stream's own length is that fingerprint now.
  const [doorState, setDoorState] = useState<DoorTranscriptState | null>(null)
  useEffect(() => {
    if (!remote) return
    const read = cookrew().traceStatus
    if (!read) return
    let alive = true
    void read(node.id)
      .then((state) => {
        if (alive) setDoorState(state)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // The stream's own length is the change signal now: it moves whenever the
    // record grows, which is the same fingerprint the door poll reported and
    // one fewer subscription to keep in step.
  }, [remote, node.id, stream.total, stream.opened])
  // A refused attach says so where the strip already speaks, then clears.
  const [attachRefusal, setAttachRefusal] = useState<string | null>(null)
  const refusalTimer = useRef<number | null>(null)
  const refuseAttach = (): void => {
    setAttachRefusal(
      `Attachments stay on this machine — this team runs at @${node.servedSession?.slug ?? '?'}.`
    )
    if (refusalTimer.current !== null) window.clearTimeout(refusalTimer.current)
    refusalTimer.current = window.setTimeout(() => {
      refusalTimer.current = null
      setAttachRefusal(null)
    }, 5000)
  }
  useEffect(
    () => () => {
      if (refusalTimer.current !== null) window.clearTimeout(refusalTimer.current)
    },
    []
  )
  const doorSentence = remote
    ? (attachRefusal ?? doorStateSentence(doorState, node.servedSession?.slug ?? '?'))
    : null

  // VERSION PINS on the rail. Fetched here and passed to the timeline, which
  // otherwise received nothing — so a saved template's pin was cut in the main
  // process and never rendered. Re-fetch on the same turn signal as the trace,
  // plus a bump when a template is saved (a save adds no turn, so turnCount
  // alone would miss it). Without the save signal the marker only appeared
  // after the next turn — which read as "save did nothing".

  const transcriptRef = useRef<TranscriptHandle>(null)
  const translation = useCheckpointTranslation()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  /**
   * PHONE PASTE. iOS offers its Paste callout only on a long-pressed
   * editable, and xterm's editable is a hidden zero-size textarea — so the
   * phone pastes from the PASTE key in the dock's control row
   * (terminal-clipboard.ts). It ends here, because the xterm is what must do
   * the pasting: it wraps the text in bracketed-paste markers when the TUI
   * has that mode on, and without them an agent's prompt reads every newline
   * in a pasted block as a submit.
   */
  const termRef = useRef<Terminal | null>(null)
  /** A beat of feedback under the header: pasted, empty, or unreadable. */
  const [clipNote, setClipNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const note = (text: string): void => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setClipNote(text)
    noteTimer.current = setTimeout(() => setClipNote(null), 1600)
  }
  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
  }, [])
  /**
   * The paste itself, asked for by the dock's PASTE key. Guarded on purpose:
   * iOS's paste prompt can sit unanswered for seconds, and a second tap
   * meanwhile must not queue a second read behind it.
   *
   * NOTHING may be awaited before pasteFromClipboard — the read has to run
   * inside the gesture that asked, or iOS refuses it.
   */
  const pastingRef = useRef(false)
  const requestPaste = (): void => {
    const term = termRef.current
    if (!term || pastingRef.current) return
    pastingRef.current = true
    void pasteFromClipboard(readClipboardText, (text) => term.paste(text))
      .then((outcome) => {
        if (outcome === 'pasted') note('Pasted')
        else if (outcome === 'empty') note('Nothing to paste')
        // Said out loud rather than swallowed: a companion served over plain
        // LAN http is not a secure context, so there is no clipboard to read
        // there at all, and a key that does nothing silently reads as broken.
        else note('Clipboard blocked here')
      })
      .finally(() => {
        pastingRef.current = false
      })
  }
  /** Latest requestPaste — the bus registration outlives a render. */
  const requestPasteRef = useRef(requestPaste)
  requestPasteRef.current = requestPaste
  // The dock's paste key asks by terminal id — see terminal-paste-bus.ts.
  useEffect(() => registerTerminalPaste(node.id, () => requestPasteRef.current()), [node.id])
  const [activeBlock, setActiveBlock] = useState<ActiveBlock>({ index: null, frac: 1 })
  // A checkpoint whose trace block is still fetching for a jump — the rail/fan
  // shows it loading so a far click gives instant feedback (item 4).
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  // Bumped on every explicit click/LIVE so a re-click of the row already in view
  // still re-scrolls (item 2a) — a same-value setSelectedIndex alone wouldn't
  // re-run the jump.
  const [jumpToken, setJumpToken] = useState(0)

  /** The transcript's identity space, MEMOISED (review, T5 QA 2026-09-07): a
   *  fresh array literal per render defeated TranscriptView's own memo of the
   *  1,048-element sorted space it derives from it. */
  const identities = useMemo(() => rows.map((r) => r.index), [rows])

  const gotoCheckpoint = (index: number): void => {
    setSelectedIndex(index)
    setJumpToken((t) => t + 1)
    // OPENING THE DRAWER AT A CHECKPOINT PAGES THE INDEX TO IT (D1, T5 QA
    // 2026-09-07). The rail's index is a window, and a jump that lands on an
    // ordinal older than the window leaves the drawer with a placeholder no
    // page will ever fill. Bounded: it stops at the page that holds it.
    void stream.ensureLoaded(index)
  }
  const goLive = (): void => {
    setSelectedIndex(null)
    setJumpToken((t) => t + 1)
  }
  // Scrolling the transcript reports the block in view (onActiveBlockChange),
  // which steps the active checkpoint; the click/scrub → selectedIndex direction
  // and this scroll → selectedIndex direction stay in sync, and TranscriptView's
  // echo-skip keeps them from fighting, so no anti-bounce guard is needed.
  const onActiveBlockChange = (active: ActiveBlock): void => {
    setActiveBlock(active)
    if (active.index === selectedIndex) return
    setSelectedIndex(active.index)
  }
  const selectedRow =
    selectedIndex !== null ? (rows.find((r) => r.index === selectedIndex) ?? null) : null
  // ONE TITLE RULE, from the mark. checkpointRowTitle is the same function the
  // rail's rows use, so the ask line and the rail can no longer disagree about
  // what a checkpoint is called — they did, whenever the ledger held a title
  // the trace listing did not.
  const selectedTitle =
    selectedRow === null ? '' : checkpointRowTitle(selectedRow, titleMode)

  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  // The LEFT rail: the agent's model and effort, read off its own record and
  // turned by one typed line. Mirror of the checkpoint rail on the right.
  const tuning = useAgentTuning({ terminalId: node.id, phase, remote })
  // The agent's face on its side of the chat (transcript-face.ts): one
  // element, so the memoised rows are not re-rendered by a new one each frame.
  const chatFace = useMemo(() => <AgentAvatar id={node.id} orch={node.orch === true} status="idle" preset={node.preset} />, [node.id, node.orch, node.preset])
  // Chat or the raw terminal (transcript-look.ts): one class on the box.
  const [look, setLook] = useTranscriptLook()
  // Read by the terminal's mount-once setup: is the live view on screen?
  const lookRef = useRef(look)
  lookRef.current = look
  /** The live terminal's local scroll (live-scroll.ts), once the terminal is up. */
  const localScrollRef = useRef<LocalScroll | null>(null)
  /** The phone's native-scroll history surface (live-sheet.ts), once the terminal is up. */
  const liveSheetRef = useRef<LiveSheet | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  /** Where the chat was read when the terminal took the box: null = at the newest. */
  const chatScroll = useRef<number | null>(null)
  const switchLook = (next: TranscriptLook): void => {
    const box = mainRef.current?.querySelector<HTMLElement>('.ctx-transcript') ?? null
    if (next === 'live' && isRecordLook(look) && box) {
      chatScroll.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24 ? null : box.scrollTop
    }
    setLook(next)
  }
  // A card with no conversation (a plain shell, an agent before its first
  // prompt) would be an empty chat: after a moment it says so and offers the
  // terminal. The moment keeps it from flashing while the stream loads.
  const [noConversation, setNoConversation] = useState(false)
  useEffect(() => {
    if (stream.total > 0) {
      setNoConversation(false)
      return
    }
    const timer = setTimeout(() => setNoConversation(true), 1200)
    return () => clearTimeout(timer)
  }, [stream.total, node.id])
  useLayoutEffect(() => {
    const box = mainRef.current?.querySelector<HTMLElement>('.ctx-transcript') ?? null
    if (!box) return
    if (look === 'live') {
      // The terminal is the whole card now: keys go to it, and its history
      // is fetched so the first scroll is local (live-scroll.ts).
      termRef.current?.focus()
      localScrollRef.current?.onLive()
      liveSheetRef.current?.sync()
      return
    }
    liveSheetRef.current?.sync()
    box.scrollTop = chatScroll.current ?? box.scrollHeight
  }, [look])
  // The RTE dial (R2). A served session never gets this machine's route, so
  // it never gets the dial either (design D3).
  const routeAllowed = routeDialAllowed({ remote, served: node.servedSession != null })
  const cardRoute = useCardRoute({ terminalId: node.id, enabled: routeAllowed })
  const zoomSlots = useZoomSlots()
  // Main's choices, and only main's (route-view.routeDialInput).
  const routeDialBase = routeDialInput({ allowed: routeAllowed, routeChoices: tuning.routeChoices, state: cardRoute.state })
  const routeDial = routeDialBase
    ? { ...routeDialBase, state: cardRoute.state, open: cardRoute.open, onOpen: cardRoute.setOpen, onPick: cardRoute.pick }
    : null

  // The phone flipped between light and dark while this was open.
  const night = useNight()
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = night ? NIGHT_THEME : PAPER_THEME
  }, [night])

  // Owner ruling 2026-08-30: the zoomed view is PTY-DIRECT for every card.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: isNight() ? NIGHT_THEME : PAPER_THEME,
      minimumContrastRatio: 4.5,
      fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      // A phone cannot hold a 5000-line scrollback for a high-output agent
      // (Conductor) on top of the WebGL/GPU cost — that is the zoom-in OOM.
      // Keep a small buffer on mobile; the paged transcript above is the real
      // history, this pane is just the live tail.
      scrollback: isRemoteMode() ? 600 : 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // OSC 52 support: tmux (set-clipboard on) forwards its mouse-drag copies
    // as OSC 52, and this addon applies them to the system clipboard — so
    // selecting in a terminal IS copying. Writes route through
    // writeClipboardText, whose execCommand fallback keeps copies working in
    // insecure remote contexts (phone over plain http) where
    // navigator.clipboard is undefined.
    try {
      const provider: IClipboardProvider = {
        readText: async () => (await readClipboardText()) ?? '',
        writeText: async (_selection, text) => {
          await writeClipboardText(text)
        }
      }
      term.loadAddon(new ClipboardAddon(undefined, provider))
    } catch {
      // clipboard unavailable — selection still works inside tmux
    }

    // Local selections (⌥+drag bypasses tmux's mouse capture) copy on
    // release too, matching the tmux-side behavior above.
    let copyTimer: ReturnType<typeof setTimeout> | null = null
    const selectionSub = term.onSelectionChange(() => {
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        const text = term.getSelection()
        if (text) void writeClipboardText(text)
      }, 150)
    })

    // The decision is pure and unit-tested (terminal-key-intent.ts); only the
    // effects live here. That split is not tidiness: this callback runs inside
    // xterm's key dispatch, so a throw does not surface as an error — it
    // swallows the keystroke. A soft keyboard's IME can hand us events with no
    // `key`, which is what silently ate the digits and punctuation from a CJK
    // keyboard's secondary layer.
    term.attachCustomKeyEventHandler((event) => {
      const intent = terminalKeyIntent(event, {
        agent: agentRef.current,
        hasSelection: term.hasSelection()
      })
      switch (intent) {
        case 'agent-newline':
          // ESC+CR is the "insert newline" binding of Claude Code and friends;
          // returning false swallows the plain CR xterm would emit.
          if (event.type === 'keydown') cookrew().ptyInput(node.id, '\x1b\r')
          return false
        case 'copy':
          if (event.type === 'keydown') void writeClipboardText(term.getSelection())
          return false
        case 'swallow-paste':
          return false
        default:
          return true
      }
    })

    // Single paste path (text AND images): reading the text off the event
    // works in insecure contexts (phone) too, and preventDefault + capture
    // suppress xterm's own native paste so nothing is inserted twice. Image
    // bytes have no file path, so they save via the attach flow like a drag-in.
    const onPaste = (event: ClipboardEvent): void => {
      handleTerminalPaste(event, {
        pasteText: (text) => term.paste(text),
        pasteImages: (images) =>
          remote
            ? refuseAttach()
            : void pasteClipboardImages(node.id, images).catch((error) =>
                console.error('Image paste failed:', error)
              )
      })
    }
    container.addEventListener('paste', onPaste, true)

    let disposed = false
    termRef.current = term
    const cleanups: Array<() => void> = [
      () => {
        termRef.current = null
        term.dispose()
      }
    ]
    cleanups.push(() => {
      if (copyTimer) clearTimeout(copyTimer)
      selectionSub.dispose()
      container.removeEventListener('paste', onPaste, true)
    })

    // xterm measures cell width once at open(). If the webfont swaps in
    // afterwards, rendered glyph width no longer matches the measured cell
    // and every row drifts — so the font must be resolved before open().
    // Resolved, or GIVEN UP ON: the font file comes from Google's CDN, and a
    // phone whose cached stylesheet names the face but whose woff2 fetch
    // hangs (tailnet up, internet down) leaves fonts.load() pending forever
    // (pending, not rejected — the catch never fires), which held term.open
    // AND ptyAttach hostage: a black live pane with no error anywhere. Past
    // the budget the fallback mono opens the terminal. ACCEPTED trade: with
    // display=swap the real face can still land later and drift the grid
    // until the next fit — a drifted terminal beats no terminal.
    let fontTimer: ReturnType<typeof setTimeout> | undefined
    const fontReady = Promise.race([
      document.fonts.load('13px "JetBrains Mono"').catch(() => undefined),
      new Promise((resolve) => {
        fontTimer = setTimeout(resolve, 1500)
      })
    ])
    cleanups.push(() => clearTimeout(fontTimer))

    void fontReady.then(() => {
      if (disposed) return
      term.open(container)

      // WebGL renderer pins every glyph to its grid cell, so CJK fallback
      // glyphs (JetBrains Mono has none) can't accumulate horizontal drift
      // the way the DOM renderer lets them. Losing the context falls back
      // to the DOM renderer, which is degraded but functional.
      //
      // NOT on a phone. There it is not one context — it is one per PAN. On a
      // phone stage every card clears the LOD coverage threshold at any normal
      // zoom (a 640-wide terminal covers 0.82 of a 390pt stage at zoom 0.5,
      // 1.00 at 0.75), so an overlay is always mounted, and panning off one
      // card onto the next flips the single overlay winner: unmount, dispose a
      // WebGL context, mount, create another. iOS Safari reclaims GPU-process
      // memory lazily, so that churn walks the web process into a jetsam kill
      // — Safari reports it as a repeating problem and then reproduces it on
      // reload, because the restored viewport mounts an overlay again.
      //
      // The DOM renderer is the documented fallback above and costs CJK grid
      // drift on phone terminals. That is a real loss and it is the smaller
      // one: the alternative is a canvas that cannot be panned. Removing the
      // drift properly means not churning overlays on pan at all (LOD
      // hysteresis in zoom-lod.ts), which is a UX decision, not a one-liner.
      if (!isRemoteMode()) {
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {
          // WebGL unavailable — DOM renderer still works
        }
      }

      // Fit can report bogus dimensions before layout finishes — retry
      // until the measured size settles. Each POST resizes the SHARED mirror
      // PTY and forces a full TUI repaint broadcast to every viewer, so a
      // retry that measured the same size must not re-send it (Pilot's
      // phone-crash hunt, 2026-08-27 — the mount burst was 4–13 identical
      // resizes, each reflowing the desktop viewer too).
      /**
       * The pane's size as this viewer last knew it — what it sent, or what the
       * pane reported. A resize to the size the pane already has is not free:
       * herdr answers EVERY resize with a full replay (`\e[2J\e[3J…`), which
       * repaints every viewer and wipes the history the live view scrolls
       * (live-scroll.ts). Measured on the phone page, 2026-10-31: the refit
       * observer re-sent the size the mount kick had just set, once per open.
       */
      let paneSize: { cols: number; rows: number } | null = null
      /** The last size this viewer asked for as its own (a repaint kick's cols-1 step is not one). */
      let mySize: PaneSize | null = null
      const sendSize = (cols: number, rows: number, kick = false): void => {
        paneSize = { cols, rows }
        if (!kick) mySize = { cols, rows }
        cookrew().ptyResize(node.id, cols, rows)
      }
      /**
       * WHO OWNS THE PANE'S SIZE: the viewer someone used last. Window focus
       * is no test — the desktop window keeps it while the owner reads on the
       * phone, and two "focused" viewers would resize the shared pane back and
       * forth, each resize a full replay and a Claude Code reprint. So a viewer
       * takes the size back only within this long of a touch, click or key in
       * it, and a touch or click claims it at once.
       */
      // The rule is pane-size.ts: the viewer used last owns the size, the
      // others adopt it and stay quiet until their own next use.
      const owner = createSizeOwner(openedAt(Date.now(), lastUserInputAt()))
      const owns = (): boolean => owner.owns(Date.now(), document.visibilityState === 'visible')
      const claimSize = (): void => {
        owner.use(Date.now())
        if (disposed || container.offsetWidth <= 40) return
        try {
          fit.fit()
          if (paneSize?.cols !== term.cols || paneSize?.rows !== term.rows) sendSize(term.cols, term.rows)
        } catch {
          // container may be mid-teardown
        }
      }
      const onUse = (): void => claimSize()
      container.addEventListener('pointerdown', onUse, true)
      container.addEventListener('touchstart', onUse, { capture: true, passive: true })
      // Dragging the window's edge, or turning the phone, is using it too; the
      // refit observer then sends the new size.
      const onWindowResize = (): void => {
        if (document.visibilityState === 'visible') owner.use(Date.now())
      }
      window.addEventListener('resize', onWindowResize)
      cleanups.push(() => {
        container.removeEventListener('pointerdown', onUse, true)
        container.removeEventListener('touchstart', onUse, true)
        window.removeEventListener('resize', onWindowResize)
      })
      const fitUntilStable = (attempt = 0): void => {
        // A viewer nobody opened keeps the pane's size: the hello sets its grid.
        if (disposed || !owns()) return
        try {
          if (container.offsetWidth > 40) {
            fit.fit()
            // Against the pane's size, not what this viewer last sent: a
            // hello may have moved the pane since, and a grid refitted without
            // telling the pane is the wrong width for every frame after.
            if (paneSize?.cols !== term.cols || paneSize?.rows !== term.rows) sendSize(term.cols, term.rows)
          }
        } catch {
          // ignore; retried below
        }
        if (attempt < 8 && (term.cols < 20 || container.offsetWidth <= 40)) {
          setTimeout(() => fitUntilStable(attempt + 1), 250 * (attempt + 1))
        }
      }
      fitUntilStable()

      // Adopt the mirror's geometry BEFORE the first byte. The replay frame is
      // serialized at the mirror's columns and herdr's later deltas address the
      // cursor absolutely against them, so painting them into a differently
      // sized grid re-wraps lines and drops blocks at the wrong rows — the
      // scrambled transcript. The fit-driven resize kick below then moves the
      // PANE to this viewer's size, and the server answers with a fresh frame.
      // Adoption needs a counterweight. Adopting alone means the LAST viewer
      // to resize owns every other viewer's layout forever: a phone opening
      // the same terminal shrinks the pane to 45x24 and the desktop renders a
      // narrow strip in a full-width card until someone drags the window
      // (measured in herdr mode; tmux mode behaved as last-writer-wins, so
      // the active viewer always recovered). The rule that restores that:
      // adopt the frame so it paints correctly, then — if THIS viewer is the
      // focused one and the pane's size is not its own — re-assert its fitted
      // size. Idle viewers adopt and stay quiet, so two viewers cannot fight.
      let reassertTimer: ReturnType<typeof setTimeout> | null = null
      // Claude Code's media-control symbols as a phone can draw them: the iOS
      // crash guard, ⏺ → ●, and the footer's ⏵⏵ that were tofu (phone-glyphs.ts).
      // Remote only: desktop WebKit shapes these fine.
      const detoxify = (raw: string): string => (isRemoteMode() ? phoneGlyphs(raw) : raw)
      /**
       * SIGWINCH: make the TUI repaint its real screen at this size. One
       * column narrower, then back: Claude Code redraws everything only when
       * the terminal gets NARROWER, and a render it makes at the dip that
       * lands late only leaves a margin. Never wider first: a late render at
       * a wider size spills every padded row onto a row of its own (owner,
       * 2026-10-31: a blank row under every line, the input box jumping;
       * main/pty.ts · PtySession.resize).
       *
       * Back to the size the pane had BEFORE the kick, read then: by the
       * settle this viewer has adopted the dip from main's hello, and
       * settling on term.cols would keep it. A kick while one is in flight
       * (the mount's and a turn's end can meet) goes back to the same size:
       * read afresh it would be the dip, and the pane lost a column a kick.
       */
      /** How long the kick's dip holds: long enough for Claude Code to redraw at it (main/pty.ts DIP_MS). */
      const KICK_DIP_MS = 400
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let lastKickAt = 0
      /** The size an in-flight kick goes back to. */
      let kickBack: PaneSize | null = null
      const repaintKick = (): void => {
        const at = kickBack ?? paneSize ?? { cols: term.cols, rows: term.rows }
        if (disposed || at.cols < 21) return
        lastKickAt = Date.now()
        kickBack = at
        sendSize(at.cols - 1, at.rows, true)
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          kickBack = null
          if (!disposed) sendSize(at.cols, at.rows)
        }, KICK_DIP_MS)
      }
      kickRef.current = repaintKick
      ownsRef.current = owns
      /**
       * A RE-hello is a reconnect, and a reconnect may have found a mirror
       * that was rebuilt while the link was down — whose replay frame is an
       * empty screen an idle agent never repaints (the phone's black live
       * pane). The mount kick below cannot help: nothing remounted. So kick
       * again on a later hello — COALESCED, because every kick resizes the
       * SHARED mirror and repaints it for every other viewer too, and a
       * flapping link reconnects several times a second.
       */
      let helloSeen = false
      let rekickTimer: ReturnType<typeof setTimeout> | null = null
      cleanups.push(() => {
        if (settleTimer) clearTimeout(settleTimer)
        if (rekickTimer) clearTimeout(rekickTimer)
      })
      // The live view scrolls its own copy of the pane's history (live-scroll.ts).
      const api = cookrew()
      const localScroll = installLocalScroll(term, {
        seed: (nonce, lines) => api.ptySeed?.(node.id, nonce, lines) ?? Promise.resolve(false),
        live: () => lookRef.current === 'live',
        lines: isRemoteMode() ? 400 : 1000,
        refreshMs: isRemoteMode() ? 8000 : 3000,
        history: () => activityRef.current?.scrollBase ?? null
      })
      localScrollRef.current = localScroll
      // Full repaints (a replay, the history seed) land under a copy of the
      // painted rows, so the reader never sees one half-parsed (live-curtain.ts).
      const curtain = createCurtain(
        domCurtainDeps(
          () => term.element?.querySelector('.xterm-screen') ?? null,
          () => term.options.theme?.background ?? PAPER_THEME.background
        )
      )
      cleanups.push(() => curtain.dispose())
      // ON A PHONE the history scrolls as a native page over the terminal, the
      // way the chat does, instead of a row at a time (live-sheet.ts).
      if (isRemoteMode()) {
        const liveSheet = installLiveSheet(term, container, {
          live: () => lookRef.current === 'live',
          wantHistory: () => localScroll.onLive()
        })
        // A seed replaces the history; this handler runs before live-scroll's
        // and passes the sequence on (false).
        const seedSeen = term.parser.registerOscHandler(777, (data) => {
          if (data.startsWith('cookrew-seed;')) liveSheet.invalidate()
          return false
        })
        liveSheetRef.current = liveSheet
        cleanups.push(() => {
          seedSeen.dispose()
          liveSheet.dispose()
          if (liveSheetRef.current === liveSheet) liveSheetRef.current = null
        })
      }
      cleanups.push(() => {
        localScroll.dispose()
        if (localScrollRef.current === localScroll) localScrollRef.current = null
      })
      const detach = cookrew().ptyAttach(
        node.id,
        (raw) => {
          // On paper, Claude Code's white cursor cell is drawn as an ink block (paper-cursor.ts).
          const chunk = isNight() ? raw : paperCursor(raw)
          if (localScroll.admit(chunk)) curtain.write(detoxify(chunk), (c, done) => term.write(c, done))
        },
        (hello) => {
          const { cols, rows } = hello
          if (disposed || cols <= 0 || rows <= 0) return
          // A widen is judged HERE, on the size the pane reports (every resize is
          // echoed, to the viewer that asked too), never on what a viewer asks:
          // an ask recorded first would hide its own widen from the echo. A
          // kick's dip and its way back are no widen (turn-redraw.ts · DIP_MEMORY_MS).
          if ((hello as { resized?: boolean }).resized) turnRedraw.current.sized(cols, activityRef.current?.phase ?? 'idle', Date.now())
          else turnRedraw.current.note(cols, Date.now())
          paneSize = { cols, rows }
          term.resize(cols, rows)
          // The pane changed size (every viewer is told, the one that asked
          // too): adopt it, so herdr's repaints land on the right cells. If it
          // settles on a size this viewer did not ask for, somebody else is
          // using the pane — give the size up, and take it back only on this
          // viewer's own next touch, click or key. Never on a timer: two
          // viewers that each took it back were the bounce.
          if ((hello as { resized?: boolean }).resized) {
            if (reassertTimer) clearTimeout(reassertTimer)
            reassertTimer = setTimeout(() => {
              if (paneSize && tookOthers(paneSize, mySize)) owner.yieldTo()
            }, SETTLE_CHECK_MS)
            return
          }
          if (helloSeen && owns() && Date.now() - lastKickAt > 2000) {
            if (rekickTimer) clearTimeout(rekickTimer)
            rekickTimer = setTimeout(repaintKick, 120)
          }
          helloSeen = true
          // A reconnect: the viewer in use puts its own size back; the rest adopt.
          if (!owns()) return
          if (reassertTimer) clearTimeout(reassertTimer)
          reassertTimer = setTimeout(() => {
            if (disposed) return
            try {
              fit.fit()
              if (term.cols !== cols || term.rows !== rows) {
                sendSize(term.cols, term.rows)
              }
            } catch {
              // container may be mid-teardown
            }
          }, 400)
        }
      )
      // Asked only now: the attach is listening, so the seed cannot arrive unheard.
      if (lookRef.current === 'live') localScroll.onLive()
      cleanups.push(() => {
        if (reassertTimer) clearTimeout(reassertTimer)
      })
      // Typing here is using this viewer: the first key after a pause takes
      // the pane's size back (claimSize), the rest only keep it.
      const typed = (input: string): void => {
        if (!owns()) claimSize()
        else owner.use(Date.now())
        cookrew().ptyInput(node.id, input)
      }
      // On a phone the keyboard's field is the truth (textarea-pad.ts): xterm
      // sends its keys, the field sends its edits, so a composition update
      // replaces the word instead of appending it. Should xterm's internals not
      // be the shape the mute expects, the field stays xterm's and the bridge's.
      const phoneField =
        isRemoteMode() && term.textarea && muteXtermFieldSends(term)
          ? attachPhoneField(term.textarea, container, { send: typed })
          : null
      // Counts every emit so the IME bridge can tell whether xterm already
      // claimed an input event — see ime-input-bridge.ts for why iOS needs one.
      // Count AND a short log of what was sent: the bridge needs the text to
      // recognise a letter xterm emitted just before the input event it is
      // deciding about (a count cannot see that — see withoutWhatXtermJustSent).
      let xtermDataCount = 0
      let xtermRecent: { at: number; text: string }[] = []
      const inputSub = term.onData((data) => {
        xtermDataCount += 1
        phoneField?.xtermSent(data)
        xtermRecent = [...xtermRecent.slice(-15), { at: Date.now(), text: data }]
        typed(data)
      })
      if (phoneField) {
        cleanups.push(() => phoneField.detach())
      } else {
        cleanups.push(
          attachImeBridge(
            container,
            () => ({ count: xtermDataCount, log: xtermRecent }),
            (text) => cookrew().ptyInput(node.id, text)
          )
        )
      }
      // Focus pops the software keyboard AND (with a small-font textarea)
      // iOS's page auto-zoom — on a phone that fired the zoom/resize loop the
      // moment the overlay opened. Desktop keeps instant focus; the phone
      // focuses on the first deliberate tap of the pane.
      if (!isRemoteMode()) {
        term.focus()
      } else {
        const focusOnTap = (): void => term.focus()
        container.addEventListener('pointerup', focusOnTap, { once: true })
        cleanups.push(() => container.removeEventListener('pointerup', focusOnTap))
      }

      // The attach replay is plain text and cannot reconstruct a TUI's
      // internal screen state — incremental redraws (ink/Claude Code) then
      // land on a wrong baseline and scatter. A double resize (SIGWINCH)
      // forces the app to repaint its real screen at the overlay size.
      // Only the viewer in use: a kick is a resize of the SHARED pane.
      //
      // ONCE, when the box has settled: a full view lays itself out over its
      // first moments (the head, the dock, the side groups), and a kick at a
      // fixed 200 ms overlapped those refits — four resizes of the shared
      // pane on one open, each a full repaint and a redraw by the agent
      // (traced 2026-11-01). Every box change in the first moments moves it.
      const mountedAt = Date.now()
      let kickTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleMountKick = (): void => {
        if (kickTimer) clearTimeout(kickTimer)
        kickTimer = setTimeout(() => {
          kickTimer = null
          if (owns()) repaintKick()
        }, MOUNT_KICK_SETTLE_MS)
      }
      scheduleMountKick()
      cleanups.push(() => {
        if (kickTimer) clearTimeout(kickTimer)
      })

      // Touch scrolling: tmux runs with `mouse on`, so xterm sits in
      // mouse-tracking mode and its built-in touch scrolling is disabled
      // (the handlers bail while mouse events are active — xterm marks that
      // state with the enable-mouse-events class). Bridge touch drags into
      // synthetic wheel events aimed at xterm's own wheel handler, which
      // forwards them to tmux as scroll reports — one per row of finger
      // travel, so a phone swipe scrolls like a desktop wheel. When mouse
      // tracking is off, xterm's native touch path works and the bridge
      // stands down.
      let touchY: number | null = null
      let lastTouch: { x: number; y: number } | null = null
      /** Recent samples (~last 120ms) — velocity source for the fling. */
      let history: Array<{ t: number; y: number }> = []
      /** Sub-row remainder so slow drags and glide frames still accumulate. */
      let carry = 0
      let glideRaf = 0
      let glideV = 0

      const trackingEl = (): Element | null =>
        container.querySelector('.xterm.enable-mouse-events')

      /**
       * THE ROWS FOLLOW THE FINGER (owner, 2026-10-31: "swiping live is not as
       * smooth as chat"). A swipe moves the scrollback a whole row at a time;
       * between two steps the screen is shifted by the pixels left over, so it
       * moves with the finger and the next step lands where the shift had
       * brought it. Only while the live view scrolls its OWN history — a wheel
       * that goes to the pane cannot be followed. The row height is the one
       * live-scroll.ts divides by, or the two disagree and a row is skipped.
       */
      const screenEl = (): HTMLElement | null => term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
      const rowHeight = (): number => {
        const h = screenEl()?.getBoundingClientRect().height ?? 0
        return h > 0 ? Math.max(8, h / Math.max(1, term.rows)) : Math.max(12, container.clientHeight / Math.max(term.rows, 1))
      }
      const localHistory = (): boolean =>
        lookRef.current === 'live' && term.buffer.active.type === 'normal' && term.buffer.active.baseY > 0
      const shiftRows = (px: number, settle = false): void => {
        const el = screenEl()
        if (!el) return
        el.style.transition = settle ? 'transform 140ms ease-out' : 'none'
        el.style.transform = px === 0 ? '' : `translateY(${px}px)`
      }
      const emitScroll = (px: number): void => {
        const target = trackingEl()
        if (!target || !lastTouch) return
        const rowPx = rowHeight()
        carry += px
        while (Math.abs(carry) >= rowPx) {
          const sign = carry > 0 ? 1 : -1
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: lastTouch.x,
              clientY: lastTouch.y,
              deltaY: sign * rowPx,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL
            })
          )
          carry -= sign * rowPx
        }
        const buf = term.buffer.active
        shiftRows(
          localHistory()
            ? subRowShift({ carry, rowPx, atTop: buf.viewportY <= 0, atBottom: buf.viewportY >= buf.baseY })
            : 0
        )
      }

      const stopGlide = (): void => {
        if (glideRaf) cancelAnimationFrame(glideRaf)
        glideRaf = 0
      }

      /** A touch on the phone's history surface scrolls natively; the bridge must not touch it. */
      const onSheet = (e: TouchEvent): boolean => (e.target as Element | null)?.closest?.('.cr-live-sheet.on') != null
      const onTouchStart = (e: TouchEvent): void => {
        if (onSheet(e)) {
          touchY = null
          return
        }
        stopGlide()
        // A finger landing mid-fling keeps the rows where they are: the shift
        // and its remainder carry on under the new drag instead of snapping.
        if (!localHistory()) {
          carry = 0
          shiftRows(0)
        }
        if (e.touches.length === 1) {
          touchY = e.touches[0].clientY
          history = [{ t: performance.now(), y: touchY }]
        } else {
          touchY = null
        }
      }
      const onTouchMove = (e: TouchEvent): void => {
        if (onSheet(e)) return
        if (touchY === null || e.touches.length !== 1 || !trackingEl()) return
        const touch = e.touches[0]
        lastTouch = { x: touch.clientX, y: touch.clientY }
        const now = performance.now()
        history = [...history.filter((h) => now - h.t < 120), { t: now, y: touch.clientY }]
        emitScroll(touchY - touch.clientY)
        touchY = touch.clientY
        e.preventDefault()
      }
      // Fling: on release, keep scrolling with the finger's exit velocity,
      // decaying exponentially (~0.9s from a hard flick) — iOS-style
      // momentum the browser can't provide because the bridge preventDefaults
      // the native gesture.
      const onTouchEnd = (): void => {
        const wasTracking = touchY !== null
        touchY = null
        if (!wasTracking) return
        const settle = (): void => {
          carry = 0
          shiftRows(0, true)
        }
        if (history.length < 2) return settle()
        const newest = history[history.length - 1]
        const oldest = history[0]
        const span = newest.t - oldest.t
        if (span <= 0) return settle()
        const velocity = (oldest.y - newest.y) / span
        if (Math.abs(velocity) < 0.25) return settle()
        glideV = Math.max(-3, Math.min(3, velocity))
        let lastFrame = performance.now()
        const frame = (now: number): void => {
          const dt = now - lastFrame
          lastFrame = now
          emitScroll(glideV * dt)
          glideV *= Math.pow(0.92, dt / 16.7)
          glideRaf = Math.abs(glideV) > 0.04 ? requestAnimationFrame(frame) : 0
          if (glideRaf === 0) settle()
        }
        glideRaf = requestAnimationFrame(frame)
      }
      const onTouchCancel = (): void => {
        touchY = null
        history = []
        carry = 0
        shiftRows(0, true)
      }
      container.addEventListener('touchstart', onTouchStart, { passive: true })
      container.addEventListener('touchmove', onTouchMove, { passive: false })
      container.addEventListener('touchend', onTouchEnd, { passive: true })
      container.addEventListener('touchcancel', onTouchCancel, { passive: true })
      cleanups.push(() => {
        stopGlide()
        container.removeEventListener('touchstart', onTouchStart)
        container.removeEventListener('touchmove', onTouchMove)
        container.removeEventListener('touchend', onTouchEnd)
        container.removeEventListener('touchcancel', onTouchCancel)
      })

      // The overlay rect keeps tracking the viewport while the user zooms
      // or pans, so resizes stream in — debounce the refit to avoid
      // hammering the TUI with SIGWINCH every frame.
      let refitTimer: ReturnType<typeof setTimeout> | null = null
      const observer = new ResizeObserver(() => {
        // Still opening: the mount kick waits for the box to settle.
        if (kickTimer !== null && Date.now() - mountedAt < MOUNT_SETTLE_WINDOW_MS) scheduleMountKick()
        if (refitTimer) clearTimeout(refitTimer)
        refitTimer = setTimeout(() => {
          // A viewer not in use keeps the adopted size: refitting it would
          // draw the pane at the wrong width here, and sending it would take
          // the pane from the viewer someone is using (pane-size.ts).
          if (!owns()) return
          try {
            fit.fit()
            if (paneSize?.cols !== term.cols || paneSize?.rows !== term.rows) sendSize(term.cols, term.rows)
          } catch {
            // container may be mid-teardown
          }
        }, 120)
      })
      observer.observe(container)

      cleanups.push(() => {
        if (refitTimer) clearTimeout(refitTimer)
        observer.disconnect()
        inputSub.dispose()
        detach()
      })
    })

    return () => {
      disposed = true
      // dispose in reverse: detach stream/observers before killing the term
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  }, [node.id])

  // Live-tail-only clip (unified-scroll item 1): when the turn is at rest, keep
  // only Forge's tail boundary in the live layer; the trace owns older
  // scrollback. Null (no clip) while a turn runs or when no boundary was found.
  const clipRows = tailClipRows(phase, activity?.tailLines ?? null)

  // Acknowledge-on-view: a mounted overlay means the user is LOOKING at this
  // terminal (desktop zoom / phone popout), so a completed turn is read the
  // moment it is — or becomes — visible here. The tracker demotes replied →
  // idle and keeps prompt/reply/title; every other phase ignores the signal,
  // so this can never end a live or waiting turn. Compact-card glances don't
  // count: no overlay, no signal.
  useEffect(() => {
    if (phase === 'replied') cookrew().turnSeen(node.id)
  }, [phase, node.id])

  // The turn came to rest after a widen it was too busy to redraw for: the
  // viewer that owns the size nudges it once (repaintKick).
  useEffect(() => {
    if (turnRedraw.current.settled(phase) && ownsRef.current()) kickRef.current?.()
  }, [phase])

  const hasFiles = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDrop = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropReady(false)
    if (remote) {
      refuseAttach()
      return
    }
    void attachFilesToTerminal(node.id, Array.from(e.dataTransfer.files)).catch((error) =>
      console.error('Attachment drop failed:', error)
    )
  }

  const pickTranslation = (code: string): void => {
    /**
     * NO SELECTION MEANS THE NEWEST, not nothing.
     *
     * This used to be disabled whenever selectedIndex was null, which
     * on a phone is how every card opens — you tap in, you are live,
     * and the button is dead. The reason it was dead lived in a
     * `title` tooltip, and touch devices do not show tooltips, so it
     * was an inert control with an invisible explanation. Live is not
     * "no checkpoint": it is the latest one, which is exactly the
     * body someone opening a card wants read back to them.
     */
    const target = selectedIndex ?? rows[rows.length - 1]?.index ?? null
    if (target === null) {
      translation.note('This card has no checkpoint to translate yet.')
      return
    }
    // The text comes from the view that already rendered it. A
    // checkpoint scrolled far out of the loaded window has been
    // evicted, and saying so beats a button that looks broken.
    const body = transcriptRef.current?.blockText(target) ?? null
    if (body === null) {
      translation.note(
        `Checkpoint T${target} is not loaded yet — scroll to it and try again.`
      )
      return
    }
    translation.translate(target, body, code)
  }

  // The card's model switch and CHAT/LIVE: on the top bar, or in the slim row.
  const barContent = (
    <div className="cr-zoom-bar" role="group" aria-label={`${node.name}: model and view`}>
      {/* ONE button for model, effort and route (owner 2026-10-31); it opens
          the whole rail, each dial still its own open → pick. */}
      {tuning.view !== null && (
        <TuneMenu
          view={tuning.view}
          open={tuning.open}
          onOpen={tuning.setOpen}
          onTurn={tuning.turn}
          error={tuning.error}
          onMouseDown={keepFocus}
          route={routeDial}
          summary={tuneSummary({ dials: tuning.view.dials, routeDial: routeDial !== null, route: cardRoute.state?.route })}
        />
      )}
      {/* ONE toggle for the transcript: it says what is showing, a tap flips it. */}
      <button
        type="button"
        className={`cr-look-toggle look-${look}`}
        aria-label={`Showing ${look} — switch to ${nextLook(look)}`}
        title={LOOK_TITLE[look]}
        onMouseDown={keepFocus}
        onClick={() => switchLook(nextLook(look))}
      >
        {LOOK_LABEL[look]}
      </button>
    </div>
  )

  return (
    <div
      className="lod-overlay"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDropReady(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropReady(false)
      }}
      onDrop={onDrop}
    >
      {/* NO HEAD (owner 2026-10-31). The model switch and CHAT/LIVE sit on the
          top bar left of ⋯; translate, titles, back and close sit inside ⋯. The
          bar names the agent already, so the name and the phase chip that were
          here said it a second time. zoom-bar.ts has the why of the portals.
          A surface with no One Bar (the cookrew.dev embed) keeps one slim row. */}
      {primary && zoomSlots.bar !== null && createPortal(barContent, zoomSlots.bar)}
      {primary && zoomSlots.bar === null && (
        <div className="popout-header slim">
          {barContent}
          <div className="popout-actions">
            <TranslateButton
              active={translation.showing !== null}
              working={translation.working}
              language={translation.language}
              onMouseDown={keepFocus}
              onClear={translation.clear}
              onPick={pickTranslation}
            />
            <button className="cr-btn sm icon" aria-label={titleMode === 'conclusion' ? 'Titles: conclusions' : 'Titles: precise prompts'} onMouseDown={keepFocus} onClick={toggleTitleMode}>
              <CrIcon name={titleMode === 'conclusion' ? 'summary' : 'terminal'} />
            </button>
            <button className="cr-btn sm icon popout-close" title="Back (Esc)" aria-label="Back" onClick={zoomBack}>
              <CrIcon name="collapse" />
            </button>
            <button className="cr-btn sm icon popout-kill" title="Close card & kill session (⌘W)" aria-label="Close card & kill session" onClick={() => requestClose(node.id)}>
              <CrIcon name="close" />
            </button>
          </div>
        </div>
      )}
      {primary && zoomSlots.menu !== null &&
        createPortal(
          <>
            <div className="cr-more-group" role="presentation">
              {node.name}
            </div>
            {/* Translate keeps ⋯ open: its language list opens from this row. */}
            <div className="cr-more-row cr-zoom-translate" role="presentation">
              <TranslateButton
                active={translation.showing !== null}
                working={translation.working}
                language={translation.language}
                onMouseDown={keepFocus}
                onClear={() => {
                  translation.clear()
                  closeZoomMenu()
                }}
                onPick={pickTranslation}
              />
              <span className="cr-more-label">Translate</span>
            </div>
            <button
              type="button"
              className="cr-more-item"
              onMouseDown={keepFocus}
              onClick={() => {
                toggleTitleMode()
                closeZoomMenu()
              }}
            >
              <CrIcon name={titleMode === 'conclusion' ? 'summary' : 'terminal'} />
              <span className="cr-more-label">
                {titleMode === 'conclusion' ? 'Titles: conclusions' : 'Titles: precise prompts'}
              </span>
            </button>
            <button
              type="button"
              className="cr-more-item"
              onClick={() => {
                closeZoomMenu()
                zoomBack()
              }}
            >
              <CrIcon name="collapse" />
              <span className="cr-more-label">Back</span>
              <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="cr-more-item danger"
              onClick={() => {
                closeZoomMenu()
                requestClose(node.id)
              }}
            >
              <CrIcon name="close" />
              <span className="cr-more-label">Close card &amp; kill session</span>
              <kbd>⌘W</kbd>
            </button>
          </>,
          zoomSlots.menu
        )}
      {clipNote !== null && (
        <div className="popout-clip-note" role="status">
          {clipNote}
        </div>
      )}
      {/* Only while a checkpoint is picked: then it says which one and is the way
          back to live. The plain "YOU ❯ <last prompt>" line is gone (owner 2026-10-31). */}
      {selectedIndex !== null && (
        <div className="popout-ask" title={selectedRow?.promptHead ?? selectedTitle ?? activity?.prompt ?? ''}>
          <span className="popout-ask-label">
            {/* Identity, not array position: T-number matches transcript + rail. */}
            {selectedIndex === null ? 'YOU ❯' : `CHECKPOINT T${selectedIndex} ❯`}
          </span>
          <span className="popout-ask-text">
            {selectedIndex !== null ? clip(selectedTitle, 300) : clip(activity?.prompt ?? '', 300)}
          </span>
          {selectedIndex !== null && (
            <button
              className="cr-btn sm popout-ask-live"
              title="Back to live"
              onMouseDown={keepFocus}
              onClick={goLive}
            >
              LIVE
            </button>
          )}
        </div>
      )}
      {/* SAY WHICH WORDS THESE ARE.
          A translated body is still prose in a card that usually holds the
          agent's own words, and the difference is invisible once you are
          reading it. This strip is the only thing that distinguishes "the agent
          said this" from "a 1.5b model's rendering of what the agent said" —
          and when Sous fails it is where the reason goes, instead of a button
          that silently does nothing. */}
      {(translation.working || translation.error !== null || translation.showing !== null) && (
        <div
          className={`popout-translation${translation.error !== null ? ' failed' : ''}`}
          role="status"
        >
          {translation.working ? (
            <span>
              Translating into {languageName(translation.language)}
              {translation.host !== null ? ` via ${translation.host}` : ' on this machine'}
              {/* The count is the whole point of the strip on a long body: a
                  local model runs about 19s per 3000 characters, so without a
                  number that moves there is no way to tell working from hung. */}
              {translation.progress !== null &&
                translation.progress.total > 1 &&
                ` — ${translation.progress.done} of ${translation.progress.total}`}
              …
            </span>
          ) : translation.error !== null ? (
            <span>{translation.error}</span>
          ) : (
            <span>
              Showing {languageName(translation.language)} — a translation of this checkpoint, not
              the words on disk.
              {translation.host !== null && ` Translated by ${translation.host}.`}
            </span>
          )}
          {/* A way out of a long one. It abandons the RESULT rather than
              aborting the request — the model keeps going and the reply is
              discarded — but "stop waiting" is the thing the reader actually
              wants, and having no exit at all is what makes a slow translation
              feel like a broken one. */}
          {translation.working && (
            <button className="cr-btn sm" onMouseDown={keepFocus} onClick={translation.clear}>
              STOP
            </button>
          )}
          {!translation.working && translation.showing !== null && (
            <button className="cr-btn sm" onMouseDown={keepFocus} onClick={translation.clear}>
              SHOW ORIGINAL
            </button>
          )}
          {!translation.working && translation.error !== null && translation.showing === null && (
            <button className="cr-btn sm" onMouseDown={keepFocus} onClick={translation.clear}>
              DISMISS
            </button>
          )}
        </div>
      )}
      {/* WHAT THIS CARD IS ON. A placed orch card is a line into a session at
          someone else's app, bought once at admission; without this the caller
          is told nothing after the money moves — not what they got, not whose
          machine it runs on. One dim line, not a badge: it answers a question
          people ask occasionally, and must not compete with the agent. */}
      {node.servedSession && (
        <div className="popout-session" role="note">
          <span className="k">THIS SESSION</span>
          <span>opened {openedLabel(node.servedSession.openedAt)}</span>
          <span className="sep">·</span>
          <span>
            {node.servedSession.paid
              ? `paid ${node.servedSession.paid.price} ${node.servedSession.paid.asset} once, at the start`
              : 'free — this team charges nothing'}
          </span>
          <span className="sep">·</span>
          <span>runs at @{node.servedSession.slug}</span>
          {doorSentence && (
            <>
              <span className="sep">·</span>
              <span className="popout-session-note" role="status">
                {doorSentence}
              </span>
            </>
          )}
        </div>
      )}
      <div className="popout-terminal-wrap">
        {/* The left column: the dials, then this terminal's browsers and notes as side tabs. */}
        {/* The left column: this terminal's browsers and notes as side tabs. The
            dials moved to the top bar (one model switch; zoom-bar.ts). */}
        {sideTabs && attachments.length > 0 && (
          <div className="popout-side">
            <AttachTabs terminalId={node.id} items={attachments} openId={openItem?.node.id ?? null} />
          </div>
        )}
        <div ref={mainRef} className={`popout-main look-${look}${isRecordLook(look) ? ' look-records' : ''}${openItem !== null ? ' split' : ''}`}>
        <TranscriptFaceContext.Provider value={chatFace}>
        <TranscriptView
          ref={transcriptRef}
          terminalId={node.id}
          pager={pager}
          // The STREAM's length, not the PTY's turn count: the scrape counts
          // what it saw on a screen and the stream counts what is in the
          // record, and a compaction is exactly where they disagree.
          total={stream.total}
          titleMode={titleMode}
          translation={translation.showing}
          identities={identities}
          selectedIndex={selectedIndex}
          jumpToken={jumpToken}
          clipRows={clipRows}
          atRest={phase === 'idle' || phase === 'replied'}
          liveEdges={() => {
            const row = activityRef.current?.scrollRow ?? null
            const base = activityRef.current?.scrollBase ?? null
            return {
              // Not in copy-mode (null) is the bottom; copy-mode at history
              // size is the top — every line the pane remembers is on screen.
              atTop: row !== null && base !== null && row >= base,
              atBottom: row === null || row === 0
            }
          }}
          onActiveBlockChange={onActiveBlockChange}
          onPending={setPendingIndex}
          onTailLoaded={() => setTailReady(true)}
          refreshToken={0}
>
          {/* PTY-direct for every card (owner ruling 2026-08-30). */}
          <div ref={containerRef} className="popout-terminal" />
        </TranscriptView>
        </TranscriptFaceContext.Provider>
        {isRecordLook(look) && noConversation && phase !== 'thinking' && (
          <div className="chat-empty">
            <span>No conversation yet.</span>
            <button type="button" className="cr-btn sm" onClick={() => switchLook('live')}>
              Open terminal
            </button>
          </div>
        )}
        {isRecordLook(look) && (phase === 'thinking' || phase === 'waiting') && (
          <ChatStatus
            phase={phase}
            name={node.name}
            status={activity?.glance?.status ?? null}
            tool={activity?.glance?.tools.at(-1) ?? null}
            onTerminal={() => switchLook('live')}
          />
        )}
        {openItem !== null && openView !== null && <AttachPanel key={openItem.node.id} item={openItem} view={openView} cardRect={rect} />}
        </div>
        <CheckpointTimeline
          terminalId={node.id}
          rows={rows}
          // The chain's length, not the page this client has fetched.
          total={stream.total}
          markers={traceMarkers}
          titleMode={titleMode}
          activeIndex={activeBlock.index}
          loadingIndex={pendingIndex}
          markerFrac={activeBlock.frac}
          allowActions={!remote}
          lineageReach={!remote}
          ended={doorState?.kind === 'ended'}
          anomalyNote={stream.anomalyNote}
          onGoto={gotoCheckpoint}
          onLive={goLive}
          onScrub={(fraction) => transcriptRef.current?.scrubTo(fraction)}
          onReach={stream.reach}
        />
      </div>
      {dropReady && (
        <div className="attach-drop-hint">
          <span>
            <CrIcon name="attach" />{' '}
            {remote ? 'ATTACHMENTS STAY HERE — THIS TEAM RUNS ELSEWHERE' : 'DROP TO ATTACH'}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * WHAT THE AGENT IS DOING RIGHT NOW, under the chat (transcript-look.ts).
 * The chat shows finished exchanges; the turn in flight is this line — its
 * status verb and newest tool call, read off the terminal by the tracker.
 * An agent waiting on you is usually waiting on its terminal (a permission,
 * a choice), so that one comes with the way there.
 */
function ChatStatus({
  phase,
  name,
  status,
  tool,
  onTerminal
}: {
  phase: 'thinking' | 'waiting'
  name: string
  status: string | null
  tool: string | null
  onTerminal: () => void
}): React.JSX.Element {
  return (
    <div className={`chat-status ${phase}`} role="status">
      <span className="chat-status-dot" aria-hidden="true" />
      <span className="chat-status-text">{phase === 'waiting' ? `${name} needs you` : (status ?? `${name} is working…`)}</span>
      {tool && <span className="chat-status-tool">{tool}</span>}
      {phase === 'waiting' && (
        <button type="button" className="cr-btn sm" onClick={onTerminal}>
          Open terminal
        </button>
      )}
    </div>
  )
}

