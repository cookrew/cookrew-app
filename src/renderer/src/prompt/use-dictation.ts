import { useCallback, useEffect, useRef, useState } from 'react'
import { PTT_IDLE, pttStep, type PttState } from '../../../shared/ptt-machine'
import type { ListenEvent } from '../../../main/listen'
import { cookrew } from '../api'
import { isAndroid, pickEar, preferPhoneEar, transcriptOf, WEB_EAR_BROKEN_KEY, webEarUnreachable, webEndError, webErrorText, webLang, webRecognizer, type Ear, type Recognizer } from './dictation'
import { micErrorText, PHONE_MAX_SECONDS } from './phone-audio'
import { canRecord, startPhoneRecording, type PhoneRecording } from './phone-recorder'

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
  /** The Mac can hear what this surface records (GET /api/listen). */
  const [phone, setPhone] = useState(false)
  const [preferPhone, setPreferPhone] = useState(preferPhoneHere)
  /** The language the Mac hears in (GET /api/listen); the browser's ear uses it too. */
  const [macLocale, setMacLocale] = useState<string | null>(null)
  const ear = pickEar(mac, Web !== null, phone, preferPhone)
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
  const recordingRef = useRef<{ recording: PhoneRecording; timer: number } | null>(null)
  /** The recording on its way to the Mac: a tap, or the deadline, gives up on it. */
  const uploadRef = useRef<AbortController | null>(null)
  /** stop, for the phone's own time limit (declared before stop exists). */
  const stopRef = useRef<() => void>(() => undefined)
  const pttRef = useRef<PttState>(PTT_IDLE)

  useEffect(() => {
    let alive = true
    void cookrew()
      .listenAvailable()
      .then((ok) => {
        if (alive) setMac(ok)
      })
      .catch(() => undefined)
    void (cookrew().hearLocale?.() ?? Promise.resolve(null))
      .then((locale) => {
        if (alive) setMacLocale(locale)
      })
      .catch(() => undefined)
    if (canRecord()) {
      void (cookrew().hearAvailable?.() ?? Promise.resolve(false))
        .then((ok) => {
          if (alive) setPhone(ok)
        })
        .catch(() => undefined)
    }
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
    let missed = false
    recognizer.lang = webLang(macLocale)
    recognizer.interimResults = true
    // Android listens through pauses until the mic is tapped; a mic forgotten
    // open stops itself, and its words still land, as the phone's recording does.
    recognizer.continuous = isAndroid(window.navigator?.userAgent)
    const limit = recognizer.continuous ? window.setTimeout(() => stopRef.current(), PHONE_MAX_SECONDS * 1000) : undefined
    recognizer.onnomatch = () => {
      missed = true
    }
    recognizer.onresult = (event) => {
      said = transcriptOf(event.results)
      setHeard(said)
    }
    recognizer.onerror = (event) => {
      failed = webErrorText(event.error)
      // The browser's recognizer has no service here: from now on this
      // surface records for the Mac to hear, if the Mac can.
      if (webEarUnreachable(event.error)) {
        markWebEarBroken()
        setPreferPhone(true)
        if (phone) failed = `${failed ?? 'Speech recognition is not reachable here.'} The mic now records for the Mac to hear: tap it again.`
        // The first look at the Mac's ear may have failed: look again.
        else if (canRecord()) void (cookrew().hearAvailable?.() ?? Promise.resolve(false)).then(setPhone).catch(() => undefined)
      }
    }
    recognizer.onend = () => {
      window.clearTimeout(limit)
      finish(said, [], webEndError(failed, missed, said))
    }
    recognizerRef.current = recognizer
    try {
      recognizer.start()
    } catch (e) {
      window.clearTimeout(limit)
      finish('', [], `Dictation could not start: ${String(e)}`)
    }
  }, [Web, finish, phone, macLocale])

  /** The phone records; the Mac hears it once the mic closes (stopPhone). */
  const startPhone = useCallback((): void => {
    let recording: PhoneRecording
    try {
      recording = startPhoneRecording()
    } catch (e) {
      finish('', [], micErrorText(e))
      return
    }
    // A mic held open past the limit stops itself, and its words still land.
    const timer = window.setTimeout(() => stopRef.current(), PHONE_MAX_SECONDS * 1000)
    recordingRef.current = { recording, timer }
    recording.ready.catch((e: unknown) => {
      if (recordingRef.current?.recording !== recording) return
      window.clearTimeout(timer)
      recordingRef.current = null
      recording.cancel()
      finish('', [], micErrorText(e))
    })
  }, [finish])

  const stopPhone = useCallback(
    (held: { recording: PhoneRecording; timer: number }): void => {
      window.clearTimeout(held.timer)
      recordingRef.current = null
      void held.recording
        .stop()
        .then((wav) => {
          if (!wav) return finish('')
          const hear = cookrew().hearRecording
          if (!hear) return finish('', [], 'This Mac cannot hear the phone.')
          const upload = new AbortController()
          uploadRef.current = upload
          const deadline = window.setTimeout(() => upload.abort('deadline'), hearDeadlineMs(wav.length))
          return hear(new Blob([wav.slice().buffer], { type: 'audio/wav' }), upload.signal)
            .then((heard) => {
              if (!upload.signal.aborted) finish(heard.text, Object.values(heard.alternates ?? {}))
            })
            .catch((e: unknown) => {
              // A tap gave up on it: that tap already closed the ear.
              if (upload.signal.reason === 'tap') return
              throw upload.signal.reason === 'deadline' ? new Error('the Mac took too long; tap the mic to try again') : e
            })
            .finally(() => {
              window.clearTimeout(deadline)
              if (uploadRef.current === upload) uploadRef.current = null
            })
        })
        .catch((e: unknown) => finish('', [], `The Mac did not hear it: ${e instanceof Error ? e.message : String(e)}`))
    },
    [finish]
  )

  const start = useCallback(
    (source: Source): void => {
      if (sourceRef.current !== null || ear === null) return
      sourceRef.current = source
      setHeard('')
      setPhase('hearing')
      onStartRef.current()
      if (ear === 'web') return startWeb()
      if (ear === 'phone') return startPhone()
      void cookrew()
        .listenStart()
        .then((ok) => {
          if (!ok) finish('', [], 'The microphone did not start.')
        })
        .catch((e: unknown) => finish('', [], `The microphone did not start: ${String(e)}`))
    },
    [ear, startWeb, startPhone, finish]
  )

  const stop = useCallback((): void => {
    if (sourceRef.current === null) return
    // A tap while the Mac is still hearing gives up on it: the mic is free again.
    const upload = uploadRef.current
    if (upload) {
      uploadRef.current = null
      upload.abort('tap')
      finish('')
      return
    }
    setPhase((now) => (now === 'hearing' ? 'closing' : now))
    const held = recordingRef.current
    if (held) stopPhone(held)
    else if (recognizerRef.current) recognizerRef.current.stop()
    else void cookrew().listenStop()
  }, [stopPhone, finish])
  stopRef.current = stop

  const toggle = useCallback((): void => {
    if (sourceRef.current !== null) stop()
    else start('button')
  }, [start, stop])

  // The Mac's ear streams here; anything that arrives with nobody listening
  // (a stray final after a stop) is not this box's.
  useEffect(
    () =>
      cookrew().onListenEvent((event: ListenEvent) => {
        if (sourceRef.current === null || recognizerRef.current || recordingRef.current) return
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

  // The box going away takes the open ear with it. The phone's recording is
  // dropped, never heard: words heard for a box that is gone must not land, or
  // reach Sous as a half sentence.
  useEffect(
    () => () => {
      const held = recordingRef.current
      const upload = uploadRef.current
      if (held || upload) {
        sourceRef.current = null
        recordingRef.current = null
        uploadRef.current = null
        if (held) {
          window.clearTimeout(held.timer)
          held.recording.cancel()
        }
        upload?.abort('tap')
        return
      }
      stop()
    },
    [stop]
  )

  return { ear, phase, listening: phase !== 'idle', heard, toggle, stop }
}

/** A browser whose own recognizer already failed for want of its service. */
function preferPhoneHere(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return preferPhoneEar(window.localStorage?.getItem(WEB_EAR_BROKEN_KEY))
  } catch {
    return false
  }
}

function markWebEarBroken(): void {
  try {
    window.localStorage.setItem(WEB_EAR_BROKEN_KEY, '1')
  } catch {
    // Private mode: it holds for this page only.
  }
}

/** How long the Mac may take over a recording of this many WAV bytes: its length, and half a minute more. */
export function hearDeadlineMs(wavBytes: number): number {
  return Math.ceil(wavBytes / 32) + 30_000
}
