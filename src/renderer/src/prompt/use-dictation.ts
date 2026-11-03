import { useCallback, useEffect, useRef, useState } from 'react'
import { PTT_IDLE, pttStep, type PttState } from '../../../shared/ptt-machine'
import type { ListenEvent } from '../../../main/listen'
import { cookrew } from '../api'
import { pickEar, transcriptOf, webErrorText, webRecognizer, type Ear, type Recognizer } from './dictation'

/**
 * THE ONE EAR (owner, 2026-11-01): every way of talking to the app lands in
 * the global prompt box. The box's mic toggles it; holding ⌘ alone (timing in
 * shared/ptt-machine) holds it open. The words so far are `heard`, for the box
 * to show; the finished sentence goes to `onFinal`, and what to do with it is
 * the box's business.
 */
export interface Dictation {
  /** Which ear hears on this surface; null draws no mic. */
  ear: Ear | null
  /**
   * idle; hearing (the words so far stand in the box); closing (stopped, the
   * final not in yet: the Mac's ear waits for its other ears, up to seconds,
   * and the box is the owner's again meanwhile).
   */
  phase: 'idle' | 'hearing' | 'closing'
  listening: boolean
  /** The words so far, while listening. */
  heard: string
  toggle: () => void
  stop: () => void
}

type Source = 'button' | 'hold'

export function useDictation(options: {
  /** The ear opened: whatever the words are for is fixed now. */
  onStart: () => void
  /** The finished sentence, and what the Mac's other ears heard of it. */
  onFinal: (text: string, alternates: string[]) => void
  onError: (message: string) => void
}): Dictation {
  const [mac, setMac] = useState(false)
  const [Web] = useState(() => (typeof window === 'undefined' ? null : webRecognizer(window)))
  const ear = pickEar(mac, Web !== null)
  const [phase, setPhase] = useState<Dictation['phase']>('idle')
  const [heard, setHeard] = useState('')
  const onStartRef = useRef(options.onStart)
  onStartRef.current = options.onStart
  const onFinalRef = useRef(options.onFinal)
  onFinalRef.current = options.onFinal
  const onErrorRef = useRef(options.onError)
  onErrorRef.current = options.onError
  /** Who opened the ear: a hold of ⌘ closes only what it opened. */
  const sourceRef = useRef<Source | null>(null)
  const recognizerRef = useRef<Recognizer | null>(null)
  const pttRef = useRef<PttState>(PTT_IDLE)

  useEffect(() => {
    let alive = true
    void cookrew()
      .listenAvailable()
      .then((ok) => {
        if (alive) setMac(ok)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const finish = useCallback((text: string, alternates: string[] = [], error: string | null = null): void => {
    if (sourceRef.current === null) return
    sourceRef.current = null
    recognizerRef.current = null
    pttRef.current = pttStep(pttRef.current, { type: 'ended' }, performance.now()).state
    setPhase('idle')
    setHeard('')
    // The words first: an error said after them must not be cleared by them.
    if (text.trim()) onFinalRef.current(text.trim(), alternates)
    if (error) onErrorRef.current(error)
  }, [])

  const startWeb = useCallback((): void => {
    if (!Web) return
    const recognizer = new Web()
    let said = ''
    let failed: string | null = null
    recognizer.interimResults = true
    recognizer.onresult = (event) => {
      said = transcriptOf(event.results)
      setHeard(said)
    }
    recognizer.onerror = (event) => {
      failed = webErrorText(event.error)
    }
    recognizer.onend = () => finish(said, [], failed)
    recognizerRef.current = recognizer
    try {
      recognizer.start()
    } catch (e) {
      finish('', [], `Dictation could not start: ${String(e)}`)
    }
  }, [Web, finish])

  const start = useCallback(
    (source: Source): void => {
      if (sourceRef.current !== null || ear === null) return
      sourceRef.current = source
      setHeard('')
      setPhase('hearing')
      onStartRef.current()
      if (ear === 'web') return startWeb()
      void cookrew()
        .listenStart()
        .then((ok) => {
          if (!ok) finish('', [], 'The microphone did not start.')
        })
        .catch((e: unknown) => finish('', [], `The microphone did not start: ${String(e)}`))
    },
    [ear, startWeb, finish]
  )

  const stop = useCallback((): void => {
    if (sourceRef.current === null) return
    setPhase((now) => (now === 'hearing' ? 'closing' : now))
    if (recognizerRef.current) recognizerRef.current.stop()
    else void cookrew().listenStop()
  }, [])

  const toggle = useCallback((): void => {
    if (sourceRef.current !== null) stop()
    else start('button')
  }, [start, stop])

  // The Mac's ear streams here; anything that arrives with nobody listening
  // (a stray final after a stop) is not this box's.
  useEffect(
    () =>
      cookrew().onListenEvent((event: ListenEvent) => {
        if (sourceRef.current === null || recognizerRef.current) return
        if (event.kind === 'partial') setHeard(event.text)
        else if (event.kind === 'final') finish(event.text, Object.values(event.alternates ?? {}))
        else if (event.kind === 'error') finish('', [], event.message)
      }),
    [finish]
  )

  // Hold ⌘ to talk — on the Mac's own ear only, as before: a browser's ear
  // would ask for the microphone (or stream to a cloud recognizer) every time
  // ⌘ is held a beat before a chord. The hold is measured by polling rather
  // than a one-shot timer so a key released early leaves nothing armed behind
  // it. A hold over an ear the mic already opened leaves it to the mic.
  useEffect(() => {
    if (ear !== 'mac') return
    const apply = (step: { state: PttState; action: 'start' | 'stop' | null }): void => {
      pttRef.current = step.state
      if (step.action === 'start') start('hold')
      else if (step.action === 'stop' && sourceRef.current === 'hold') stop()
    }
    const now = (): number => performance.now()
    const onKeyDown = (e: KeyboardEvent): void =>
      apply(pttStep(pttRef.current, { type: 'keydown', key: e.key, metaKey: e.metaKey, repeat: e.repeat }, now()))
    const onKeyUp = (e: KeyboardEvent): void => apply(pttStep(pttRef.current, { type: 'keyup', key: e.key }, now()))
    const onBlur = (): void => apply(pttStep(pttRef.current, { type: 'blur' }, now()))
    const ticker = window.setInterval(() => {
      if (pttRef.current.phase === 'armed') apply(pttStep(pttRef.current, { type: 'tick', now: now() }, now()))
    }, 50)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.clearInterval(ticker)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [ear, start, stop])

  // The box going away takes the open ear with it.
  useEffect(() => () => stop(), [stop])

  return { ear, phase, listening: phase !== 'idle', heard, toggle, stop }
}
