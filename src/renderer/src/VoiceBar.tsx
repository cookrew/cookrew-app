import { useEffect, useRef, useState } from 'react'
import type { TerminalActivity } from '../../shared/turn'
import { cookrew } from './api'

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

export function VoiceBar({
  terminalId,
  activity
}: {
  terminalId: string
  activity: TerminalActivity | undefined
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

  const send = (value?: string): void => {
    const message = (value ?? textRef.current).trim()
    if (!message) return
    setText('')
    cookrew().ptyInput(terminalId, message)
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

  return (
    <div className="voice-bar nodrag">
      {hasRecognition && (
        <button
          className={`cr-btn sm voice-mic${listening ? ' listening' : ''}`}
          title="Voice dictation"
          onClick={toggleMic}
        >
          🎙
        </button>
      )}
      <input
        className="voice-input"
        placeholder={listening ? 'Listening…' : 'Message this agent…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') send()
        }}
      />
      <button
        className={`cr-btn sm voice-speak${speakReplies ? ' on' : ''}`}
        title="Speak replies aloud"
        onClick={toggleSpeak}
      >
        🔊
      </button>
      <button className="cr-btn sm primary" title="Send" onClick={() => send()}>
        ➤
      </button>
    </div>
  )
}
