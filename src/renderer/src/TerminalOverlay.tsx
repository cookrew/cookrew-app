import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { IClipboardProvider } from '@xterm/addon-clipboard'
import { readClipboardText, writeClipboardText } from './clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalNodeData } from '../../shared/model'
import type { VersionPinRecord } from '../../shared/version-pin'
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
import { pasteFromClipboard, screenText } from './terminal-clipboard'
import { attachImeBridge } from './ime-input-bridge'
import { CrIcon } from './icons'
import { TranslateButton } from './TranslateButton'
import { languageByCode } from '../../shared/translate'
import { useCheckpointTranslation } from './use-checkpoint-translation'
import { StatusCoin } from './nodes/AgentAvatar'

const PHOSPHOR_THEME = {
  background: '#14110A',
  foreground: '#E9B949',
  cursor: '#FFD77A',
  cursorAccent: '#14110A',
  selectionBackground: '#5C4A1F',
  black: '#14110A',
  brightBlack: '#8A6D1C',
  white: '#FFD77A',
  brightWhite: '#FFFEF5'
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
          <TerminalOverlayFor key={t.id} node={t} rect={rects[t.id]} />
        ))}
    </>
  )
})

/** The overlay with ITS card's activity — a per-id subscription, not App's map. */
function TerminalOverlayFor({ node, rect }: { node: TerminalNodeData; rect: ScreenRect }): React.JSX.Element {
  const activity = useActivity(node.id)
  return <TerminalOverlay node={node} activity={activity} rect={rect} />
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
  rect
}: {
  node: TerminalNodeData
  activity: TerminalActivity | undefined
  rect: ScreenRect
}): React.JSX.Element {
  const { zoomBack, requestClose } = useCanvasUi()
  const phase = activity?.phase ?? 'idle'
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
  const [pins, setPins] = useState<VersionPinRecord[]>([])
  const [pinRefresh, setPinRefresh] = useState(0)
  useEffect(() => {
    const bump = (): void => setPinRefresh((n) => n + 1)
    window.addEventListener('cookrew:template-saved', bump)
    return () => window.removeEventListener('cookrew:template-saved', bump)
  }, [])
  useEffect(() => {
    if (!metadataReady) return
    let alive = true
    void cookrew()
      .listPins(node.id)
      .then((list) => {
        if (alive) setPins(list)
      })
      .catch((error) => console.error('listPins failed:', error))
    return () => {
      alive = false
    }
  }, [node.id, pinRefresh, metadataReady])

  const transcriptRef = useRef<TranscriptHandle>(null)
  const translation = useCheckpointTranslation()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  /**
   * PHONE CLIPBOARD. The zoomed terminal on a phone can neither be selected
   * (xterm selects by mouse drag; the touch bridge owns the finger) nor
   * long-pressed for iOS's Paste callout (xterm's editable is a hidden
   * zero-size textarea). Two header buttons stand in — see
   * terminal-clipboard.ts. `termRef` is the live xterm those buttons act on.
   */
  const termRef = useRef<Terminal | null>(null)
  /** A beat of feedback under the buttons ("Copied", "Nothing to paste"). */
  const [clipNote, setClipNote] = useState<string | null>(null)
  /**
   * The paste FIELD: where navigator.clipboard cannot be read (plain-http
   * LAN, or the owner declined iOS's prompt), a visible textarea the user can
   * long-press. Its `paste` event carries the text with no permission at all.
   */
  const [pasteField, setPasteField] = useState(false)
  const pasteFieldRef = useRef<HTMLTextAreaElement>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const note = (text: string): void => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setClipNote(text)
    noteTimer.current = setTimeout(() => setClipNote(null), 1600)
  }
  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
  }, [])
  useEffect(() => {
    if (pasteField) pasteFieldRef.current?.focus()
  }, [pasteField])
  const copyScreen = (): void => {
    const term = termRef.current
    if (!term) return
    const text = screenText(term.buffer.active, term.rows)
    if (text.length === 0) {
      note('Nothing on screen to copy')
      return
    }
    void writeClipboardText(text).then((ok) => note(ok ? 'Copied the screen' : 'Copy failed'))
  }
  const pasteClipboard = (): void => {
    const term = termRef.current
    if (!term) return
    void pasteFromClipboard(readClipboardText, (text) => term.paste(text)).then((outcome) => {
      if (outcome === 'pasted') note('Pasted')
      else if (outcome === 'empty') note('Nothing to paste')
      else setPasteField(true)
    })
  }
  const onPasteFieldPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = event.clipboardData.getData('text')
    event.preventDefault()
    setPasteField(false)
    if (text.length === 0) {
      note('Nothing to paste')
      return
    }
    termRef.current?.paste(text)
    note('Pasted')
  }
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

  // Owner ruling 2026-08-30: the zoomed view is PTY-DIRECT for every card.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: PHOSPHOR_THEME,
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
      let lastSent: { cols: number; rows: number } | null = null
      const fitUntilStable = (attempt = 0): void => {
        if (disposed) return
        try {
          if (container.offsetWidth > 40) {
            fit.fit()
            if (lastSent?.cols !== term.cols || lastSent?.rows !== term.rows) {
              lastSent = { cols: term.cols, rows: term.rows }
              cookrew().ptyResize(node.id, term.cols, term.rows)
            }
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
      // THE MURDER WEAPON (black box, 2026-08-27): both kills ended at the
      // redraw's final chunk — Claude Code's composer line, whose U+23F5 ⏵
      // is an EMOJI-PRESENTATION candidate on Apple platforms. iOS 26.6's
      // text engine dies resolving that fallback inside xterm's DOM-renderer
      // grid. VS15 (U+FE0E, zero width) pins every media-control symbol to
      // TEXT presentation — same glyph, same cell width, no emoji path.
      // Remote only: desktop WebKit shapes these fine.
      const detoxify = (raw: string): string =>
        isRemoteMode() ? raw.replace(/[\u23E9-\u23FA]/g, (m) => `${m}\uFE0E`) : raw
      /** SIGWINCH: make the TUI repaint its real screen at this size. */
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let lastKickAt = 0
      const repaintKick = (): void => {
        if (disposed || term.cols < 21) return
        lastKickAt = Date.now()
        cookrew().ptyResize(node.id, term.cols - 1, term.rows)
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          if (!disposed) cookrew().ptyResize(node.id, term.cols, term.rows)
        }, 60)
      }
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
      const detach = cookrew().ptyAttach(
        node.id,
        (chunk) => term.write(detoxify(chunk)),
        ({ cols, rows }) => {
          if (disposed || cols <= 0 || rows <= 0) return
          term.resize(cols, rows)
          if (helloSeen && Date.now() - lastKickAt > 2000) {
            if (rekickTimer) clearTimeout(rekickTimer)
            rekickTimer = setTimeout(repaintKick, 120)
          }
          helloSeen = true
          if (document.visibilityState !== 'visible' || !document.hasFocus()) return
          if (reassertTimer) clearTimeout(reassertTimer)
          reassertTimer = setTimeout(() => {
            if (disposed) return
            try {
              fit.fit()
              if (term.cols !== cols || term.rows !== rows) {
                cookrew().ptyResize(node.id, term.cols, term.rows)
              }
            } catch {
              // container may be mid-teardown
            }
          }, 400)
        }
      )
      cleanups.push(() => {
        if (reassertTimer) clearTimeout(reassertTimer)
      })
      // Counts every emit so the IME bridge can tell whether xterm already
      // claimed an input event — see ime-input-bridge.ts for why iOS needs one.
      // Count AND a short log of what was sent: the bridge needs the text to
      // recognise a letter xterm emitted just before the input event it is
      // deciding about (a count cannot see that — see withoutWhatXtermJustSent).
      let xtermDataCount = 0
      let xtermRecent: { at: number; text: string }[] = []
      const inputSub = term.onData((input) => {
        xtermDataCount += 1
        xtermRecent = [...xtermRecent.slice(-15), { at: Date.now(), text: input }]
        cookrew().ptyInput(node.id, input)
      })
      cleanups.push(
        attachImeBridge(
          container,
          () => ({ count: xtermDataCount, log: xtermRecent }),
          (text) => cookrew().ptyInput(node.id, text)
        )
      )
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
      const kickTimer = setTimeout(repaintKick, 200)
      cleanups.push(() => clearTimeout(kickTimer))

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

      const emitScroll = (px: number): void => {
        const target = trackingEl()
        if (!target || !lastTouch) return
        const rowPx = Math.max(12, container.clientHeight / Math.max(term.rows, 1))
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
      }

      const stopGlide = (): void => {
        if (glideRaf) cancelAnimationFrame(glideRaf)
        glideRaf = 0
      }

      const onTouchStart = (e: TouchEvent): void => {
        stopGlide()
        carry = 0
        if (e.touches.length === 1) {
          touchY = e.touches[0].clientY
          history = [{ t: performance.now(), y: touchY }]
        } else {
          touchY = null
        }
      }
      const onTouchMove = (e: TouchEvent): void => {
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
        if (!wasTracking || history.length < 2) return
        const newest = history[history.length - 1]
        const oldest = history[0]
        const span = newest.t - oldest.t
        if (span <= 0) return
        const velocity = (oldest.y - newest.y) / span
        if (Math.abs(velocity) < 0.25) return
        glideV = Math.max(-3, Math.min(3, velocity))
        let lastFrame = performance.now()
        const frame = (now: number): void => {
          const dt = now - lastFrame
          lastFrame = now
          emitScroll(glideV * dt)
          glideV *= Math.pow(0.92, dt / 16.7)
          glideRaf = Math.abs(glideV) > 0.04 ? requestAnimationFrame(frame) : 0
        }
        glideRaf = requestAnimationFrame(frame)
      }
      const onTouchCancel = (): void => {
        touchY = null
        history = []
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
        if (refitTimer) clearTimeout(refitTimer)
        refitTimer = setTimeout(() => {
          try {
            fit.fit()
            cookrew().ptyResize(node.id, term.cols, term.rows)
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
      <div className="popout-header">
        {/* One coin only: it carries both identity (brand mark) and status.
            Header line mirrors the full card: coin · name · [STATUS]. */}
        <StatusCoin phase={phase} preset={node.preset} title={`${node.name} · ${node.preset}`} />
        <span className="popout-name" title={`${node.name} · ${node.preset}`}>
          {node.name}
        </span>
        {node.orch && <span className="cr-chip amber">ORCH</span>}
        <span className={`cr-chip${PHASE_CHIP[phase].cls}`}>{PHASE_CHIP[phase].label}</span>
        <div className="popout-actions">
          <TranslateButton
            active={translation.showing !== null}
            working={translation.working}
            language={translation.language}
            onMouseDown={keepFocus}
            onClear={translation.clear}
            onPick={(code) => {
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
            }}
          />
          <button
            className="cr-btn sm icon"
            aria-label={
              titleMode === 'conclusion' ? 'Titles: conclusions' : 'Titles: precise prompts'
            }
            title={
              titleMode === 'conclusion'
                ? 'Checkpoint titles: conclusions — click for precise prompts'
                : 'Checkpoint titles: precise prompts — click for conclusions'
            }
            onMouseDown={keepFocus}
            onClick={toggleTitleMode}
          >
            <CrIcon name={titleMode === 'conclusion' ? 'summary' : 'terminal'} />
          </button>
          {/* The "fork from a past checkpoint" button is deprecated — fork is now
              available per-checkpoint in the timeline (State A hold + State B
              rows), so the standalone header button is redundant. */}
          {isRemoteMode() && (
            <>
              <button
                className="cr-btn sm icon popout-copy"
                title="Copy the screen"
                aria-label="Copy the terminal screen"
                onClick={copyScreen}
              >
                <CrIcon name="copy" />
              </button>
              <button
                className="cr-btn sm icon popout-paste"
                title="Paste from the clipboard"
                aria-label="Paste into the terminal"
                onClick={pasteClipboard}
              >
                <CrIcon name="clipboard" />
              </button>
            </>
          )}
          <button
            className="cr-btn sm icon popout-close"
            title="Back to canvas (Esc)"
            aria-label="Back to canvas"
            onClick={zoomBack}
          >
            <CrIcon name="collapse" />
          </button>
          <button
            className="cr-btn sm icon popout-kill"
            title="Close card & kill session (⌘W)"
            aria-label="Close card & kill session"
            onClick={() => requestClose(node.id)}
          >
            <CrIcon name="close" />
          </button>
        </div>
      </div>
      {clipNote !== null && (
        <div className="popout-clip-note" role="status">
          {clipNote}
        </div>
      )}
      {pasteField && (
        <div className="popout-paste-field">
          <textarea
            ref={pasteFieldRef}
            className="popout-paste-input"
            aria-label="Paste here"
            placeholder="Long-press here, then Paste"
            rows={1}
            onPaste={onPasteFieldPaste}
          />
          <button
            className="cr-btn sm"
            type="button"
            onClick={() => setPasteField(false)}
          >
            CANCEL
          </button>
        </div>
      )}
      {(selectedIndex !== null || activity?.prompt) && (
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
        <CheckpointTimeline
          terminalId={node.id}
          rows={rows}
          // The chain's length, not the page this client has fetched.
          total={stream.total}
          pins={pins}
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
