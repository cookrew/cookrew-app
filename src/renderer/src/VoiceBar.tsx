import { useCallback, useEffect, useRef } from 'react'
import { cookrew } from './api'
import { CrIcon, type CrIconName } from './icons'
import { requestTerminalPaste } from './terminal-paste-bus'
import { keyGesture, type KeyGestureState } from './touch-key-gesture'

/**
 * The tools tray inside the global prompt box (prompt/GlobalPrompt.tsx),
 * desktop AND phone: the box's extras (attach, spoken replies) and the keys a
 * touch keyboard lacks. Dictation is not here: the box has the one mic
 * (prompt/use-dictation.ts); the 🔊 switch is prompt/use-spoken-replies.ts.
 */

/**
 * What a tap on one of these does: send a PTY sequence, or ask the zoomed
 * terminal for a clipboard paste (terminal-paste-bus.ts).
 */
type TermKeyAction = { kind: 'seq'; seq: string } | { kind: 'paste' }

interface TermKey {
  label: string
  title: string
  /** Hold-to-repeat. Never for Escape, never for paste. */
  repeat: boolean
  action: TermKeyAction
  /** Drawn instead of the label: paste has no glyph of its own, and a font
   *  draws ← → smaller than ↓ ↑ (owner's phone, 2026-11-03). */
  icon?: CrIconName
}

/**
 * Control keys the touch keyboard cannot send — plus PASTE, which is not a
 * key at all. The phone has no other door to the clipboard (iOS shows its
 * callout only on a long-pressed editable, and xterm's is hidden), and this
 * row is already where the thumb is.
 *
 * Esc ← ↓ ↑ → paste, in the design's one pill form (owner, 2026-11-04; the
 * cut "Tray tools"): global-prompt.css · THE TRAY'S TOOLS, ONE FORM. No
 * numbers: a waiting agent's menu is answered from the choice box.
 */
const TERM_KEYS: TermKey[] = [
  { label: 'Esc', title: 'Escape', repeat: false, action: { kind: 'seq', seq: '\x1b' } },
  { label: '←', title: 'Arrow left', repeat: true, action: { kind: 'seq', seq: '\x1b[D' }, icon: 'arrow-left' },
  { label: '↓', title: 'Arrow down', repeat: true, action: { kind: 'seq', seq: '\x1b[B' }, icon: 'arrow-down' },
  { label: '↑', title: 'Arrow up', repeat: true, action: { kind: 'seq', seq: '\x1b[A' }, icon: 'arrow-up' },
  { label: '→', title: 'Arrow right', repeat: true, action: { kind: 'seq', seq: '\x1b[C' }, icon: 'arrow-right' },
  { label: 'PASTE', title: 'Paste from the clipboard', repeat: false, action: { kind: 'paste' }, icon: 'clipboard' }
]

/** Hold-to-repeat cadence: a pause before the first repeat, then ~14/s. */
const REPEAT_DELAY_MS = 450
const REPEAT_RATE_MS = 70

/**
 * Arrow cluster + paste + Esc beside the send button, phone companion only
 * (coarse pointer / narrow viewport via CSS): agent TUI menus (approval
 * dialogs, /model pickers, message history) are undrivable from a touch
 * keyboard without the arrows, and the clipboard is unreachable without the
 * paste key. pointerdown is swallowed and the buttons are unfocusable,
 * so a tap never dismisses the software keyboard or steals focus.
 *
 * A TAP, NOT A TOUCH (see touch-key-gesture.ts): the key lands on RELEASE,
 * so a thumb that meets this row on its way somewhere else can slide off and
 * send nothing. Firing on pointerdown made that impossible, and this row is
 * at the bottom edge where a hand rests AND scrolls sideways — so reaching
 * for → sent ESC on the way often enough to be reported. Holding still past
 * the delay fires and then repeats: paging a long scrollback or a deep menu
 * one tap per row is unusable.
 *
 * No onPointerLeave: with the pointer captured, leaving the button no longer
 * fires a boundary event, and the slop supersedes it — a finger that travels
 * off the key has already cancelled the gesture by distance.
 * Esc stays single-shot: a repeated Escape cancels past the menu you meant
 * to leave. contextmenu is swallowed so an iOS/Android long-press never
 * pops the callout over the cluster.
 */
function TermKeys({ terminalId, menuKey }: { terminalId: string; menuKey: ((seq: string) => void) | null }): React.JSX.Element {
  const timersRef = useRef<{ delay: number | null; interval: number | null }>({
    delay: null,
    interval: null
  })

  const stopRepeat = useCallback((): void => {
    const timers = timersRef.current
    if (timers.delay !== null) window.clearTimeout(timers.delay)
    if (timers.interval !== null) window.clearInterval(timers.interval)
    timers.delay = null
    timers.interval = null
  }, [])

  // A held key must die with the view (unmount) and with window blur — an
  // alert()/tab-switch mid-hold never delivers the pointerup that stops it.
  /** One gesture at a time: a second finger on another key is not a chord —
   *  enforced in the reducer by pointer ownership, not merely intended. */
  const gestureRef = useRef<KeyGestureState>({ kind: 'idle' })

  const abandon = useCallback((): void => {
    gestureRef.current = { kind: 'idle' }
    stopRepeat()
  }, [stopRepeat])

  useEffect(() => {
    window.addEventListener('blur', abandon)
    return () => {
      window.removeEventListener('blur', abandon)
      abandon()
    }
  }, [abandon])

  const drive = (key: TermKey, event: Parameters<typeof keyGesture>[1]): void => {
    const result = keyGesture(gestureRef.current, event)
    gestureRef.current = result.state
    if (result.stopRepeat) stopRepeat()
    // The paste asks SYNCHRONOUSLY, inside this pointerup: iOS grants a
    // clipboard read only in a real gesture (terminal-paste-bus.ts).
    if (result.fire) {
      if (key.action.kind === 'paste') requestTerminalPaste(terminalId)
      else if (menuKey) menuKey(key.action.seq)
      else cookrew().ptyInput(terminalId, key.action.seq)
    }
    // Not on a menu: each key is checked against its screen, so a hold's would
    // queue, and the cursor would run on after the finger lifts.
    if (result.startRepeat && key.action.kind === 'seq' && !menuKey) {
      const seq = key.action.seq
      timersRef.current.interval = window.setInterval(
        () => cookrew().ptyInput(terminalId, seq),
        REPEAT_RATE_MS
      )
    }
    // Arm the hold ONLY for keys that repeat; Escape can never mature into
    // one, so a leaned-on Escape stays a single Escape.
    if (event.type === 'down' && key.repeat) {
      timersRef.current.delay = window.setTimeout(
        () => drive(key, { type: 'hold', pointerId: event.pointerId }),
        REPEAT_DELAY_MS
      )
    }
  }

  return (
    <div className="voice-keys">
      {TERM_KEYS.map((key) => (
        <button
          key={key.title}
          type="button"
          className={`cr-btn sm cr-tray term-key${key.icon ? ' term-key-icon' : ''}`}
          tabIndex={-1}
          title={key.title}
          aria-label={key.title}
          onPointerDown={(e) => {
            // Still swallowed: a press must not dismiss the software keyboard
            // or steal focus from the xterm. It just no longer SENDS.
            e.preventDefault()
            // The gesture first: capture is an optimisation for mouse/pen
            // (touch captures implicitly), and setPointerCapture throws on an
            // inactive pointer — a throw here must not eat the keypress.
            drive(key, { type: 'down', pointerId: e.pointerId, x: e.clientX, y: e.clientY })
            try {
              e.currentTarget.setPointerCapture?.(e.pointerId)
            } catch {
              // Pointer already gone; the gesture stands on its own.
            }
          }}
          onPointerMove={(e) =>
            drive(key, { type: 'move', pointerId: e.pointerId, x: e.clientX, y: e.clientY })
          }
          onPointerUp={(e) => drive(key, { type: 'up', pointerId: e.pointerId })}
          onPointerCancel={(e) => drive(key, { type: 'cancel', pointerId: e.pointerId })}
          onContextMenu={(e) => e.preventDefault()}
        >
          {key.icon ? <CrIcon name={key.icon} /> : key.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The tray of the prompt box's tools (prompt/GlobalPrompt.tsx), drawn while
 * its ^ shows them: the extras it is handed (attach, spoken replies:
 * prompt/PromptExtras.tsx) and, with an agent in the box, its keys (arrows,
 * paste, Esc). A wide screen draws the tray in line; a phone puts it on the
 * tools row (global-prompt.css).
 */
export function VoiceBar({
  terminalId,
  menuKey = null,
  children
}: {
  /** The agent the keys drive; none for a new agent, and then no keys. */
  terminalId: string | null
  /** Where the keys go while a menu stands (wait-answer.ts · trayKey). */
  menuKey?: ((seq: string) => void) | null
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="voice-bar nodrag">
      {children}
      {terminalId && <TermKeys terminalId={terminalId} menuKey={menuKey} />}
    </div>
  )
}
