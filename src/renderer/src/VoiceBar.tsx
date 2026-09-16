import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalActivity } from '../../shared/turn'
import { cookrew } from './api'
import { AttachButton } from './AttachButton'
import { CrIcon, type CrIconName } from './icons'
import { requestTerminalPaste } from './terminal-paste-bus'
import { keyGesture, type KeyGestureState } from './touch-key-gesture'

/**
 * Voice composer for the terminal full view (desktop overlay AND phone):
 * 🎙️ dictation via the Web Speech API where the browser has it (phones;
 * on the Mac the input field works with macOS system dictation), plus a
 * 🔊 toggle that reads the agent's reply aloud when its turn completes.
 */

type Recognizer = {
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

function makeRecognizer(): Recognizer | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

function speak(text: string): void {
  const gist = (text || 'done').replace(/\s+/g, ' ').trim().slice(0, 300)
  const utterance = new SpeechSynthesisUtterance(gist)
  speechSynthesis.cancel()
  speechSynthesis.speak(utterance)
}

const SPEAK_PREF_KEY = 'cookrew-speak-replies'

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
  /** Drawn instead of the label — the paste key has no glyph of its own. */
  icon?: CrIconName
}

/**
 * Control keys the touch keyboard cannot send — plus PASTE, which is not a
 * key at all. The phone has no other door to the clipboard (iOS shows its
 * callout only on a long-pressed editable, and xterm's is hidden), and this
 * row is already where the thumb is. It sits between → and Escape by the
 * owner's placement.
 */
const TERM_KEYS: TermKey[] = [
  { label: '←', title: 'Arrow left', repeat: true, action: { kind: 'seq', seq: '\x1b[D' } },
  { label: '↓', title: 'Arrow down', repeat: true, action: { kind: 'seq', seq: '\x1b[B' } },
  { label: '↑', title: 'Arrow up', repeat: true, action: { kind: 'seq', seq: '\x1b[A' } },
  { label: '→', title: 'Arrow right', repeat: true, action: { kind: 'seq', seq: '\x1b[C' } },
  {
    label: 'PASTE',
    title: 'Paste from the clipboard',
    repeat: false,
    action: { kind: 'paste' },
    icon: 'clipboard'
  },
  { label: 'ESC', title: 'Escape', repeat: false, action: { kind: 'seq', seq: '\x1b' } }
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
function TermKeys({ terminalId }: { terminalId: string }): React.JSX.Element {
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
      else cookrew().ptyInput(terminalId, key.action.seq)
    }
    if (result.startRepeat && key.action.kind === 'seq') {
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
          className={`cr-btn sm term-key${key.icon ? ' term-key-icon' : ''}`}
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

export function VoiceBar({
  terminalId,
  activity,
  remote = false
}: {
  terminalId: string
  activity: TerminalActivity | undefined
  /** The terminal is a line into a session elsewhere: nothing here attaches. */
  remote?: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const [speakReplies, setSpeakReplies] = useState(
    () => localStorage.getItem(SPEAK_PREF_KEY) === '1'
  )
  const recognizerRef = useRef<Recognizer | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const hasRecognition = useRef(makeRecognizer() !== null).current

  // No composer input of its own — the zoomed terminal IS the input. A
  // dictated transcript is typed into the PTY and submitted; with nothing
  // dictated, send is a bare Enter that submits what's typed in the TUI.
  const send = (value?: string): void => {
    const message = (value ?? textRef.current).trim()
    setText('')
    if (message) cookrew().ptyInput(terminalId, message)
    cookrew().ptyInput(terminalId, '\r')
  }

  // Read the reply aloud when the turn lands on 'replied' while toggled on.
  const prevPhase = useRef(activity?.phase)
  useEffect(() => {
    const phase = activity?.phase
    if (speakReplies && phase === 'replied' && prevPhase.current !== 'replied' && activity?.reply) {
      speak(activity.reply)
    }
    prevPhase.current = phase
  }, [activity?.phase, activity?.reply, speakReplies])

  const toggleSpeak = (): void => {
    const next = !speakReplies
    setSpeakReplies(next)
    localStorage.setItem(SPEAK_PREF_KEY, next ? '1' : '0')
    if (next) speak('Spoken replies on')
    else speechSynthesis.cancel()
  }

  const toggleMic = (): void => {
    if (listening) {
      recognizerRef.current?.stop()
      return
    }
    const recognizer = makeRecognizer()
    if (!recognizer) return
    recognizerRef.current = recognizer
    recognizer.interimResults = true
    recognizer.onresult = (event) => {
      setText(Array.from(event.results, (r) => r[0].transcript).join(''))
    }
    recognizer.onend = () => {
      setListening(false)
      recognizerRef.current = null
      if (textRef.current.trim()) send()
    }
    setListening(true)
    setText('')
    recognizer.start()
  }

  useEffect(() => () => recognizerRef.current?.stop(), [])

  // mousedown-preventDefault keeps focus in the zoomed xterm — clicking a
  // dock button must not stop the user's typing mid-prompt.
  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div className="voice-bar nodrag">
      {!remote && <AttachButton terminalId={terminalId} />}
      {hasRecognition && (
        <button
          className={`cr-btn sm voice-mic${listening ? ' listening' : ''}`}
          title="Voice dictation"
          onMouseDown={keepFocus}
          onClick={toggleMic}
        >
          <CrIcon name="mic" />
        </button>
      )}
      {listening && (
        <span className="voice-ghost">{text.trim() ? text : 'Listening…'}</span>
      )}
      <button
        className={`cr-btn sm voice-speak${speakReplies ? ' on' : ''}`}
        title="Speak replies aloud"
        onMouseDown={keepFocus}
        onClick={toggleSpeak}
      >
        <CrIcon name="speaker" />
      </button>
      <TermKeys terminalId={terminalId} />
      <button
        className="cr-btn sm primary"
        title="Send (Enter)"
        onMouseDown={keepFocus}
        onClick={() => send()}
      >
        <CrIcon name="send" />
      </button>
    </div>
  )
}
