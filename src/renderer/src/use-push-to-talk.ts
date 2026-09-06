import { useCallback, useEffect, useRef, useState } from 'react'
import { PTT_IDLE, pttStep, type PttState } from '../../shared/ptt-machine'
import type { ListenEvent } from '../../main/listen'
import { cookrew } from './api'

/**
 * Hold ⌘ to talk to Sous. The timing lives in shared/ptt-machine (tested);
 * this hook only wires the window's keys, blur and the listener's events to
 * it, and reports what to show: whether we are listening and the words so far.
 *
 * `onFinal` receives the finished sentence — empty when the key was held in
 * silence — and whatever the caller does with it (a command on the canvas,
 * dictation into the zoomed agent) is the caller's business.
 */
export function usePushToTalk(options: {
  enabled: boolean
  /** The primary transcript, and what the other ears heard of the same audio. */
  onFinal: (text: string, alternates: string[]) => void
  onError?: (message: string) => void
}): { listening: boolean; partial: string; available: boolean } {
  const [available, setAvailable] = useState(false)
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')
  const stateRef = useRef<PttState>(PTT_IDLE)
  const onFinalRef = useRef(options.onFinal)
  onFinalRef.current = options.onFinal
  const onErrorRef = useRef(options.onError)
  onErrorRef.current = options.onError

  useEffect(() => {
    let alive = true
    void cookrew()
      .listenAvailable()
      .then((ok) => {
        if (alive) setAvailable(ok)
      })
    return () => {
      alive = false
    }
  }, [])

  const apply = useCallback((step: { state: PttState; action: 'start' | 'stop' | null }): void => {
    stateRef.current = step.state
    if (step.action === 'start') {
      setPartial('')
      setListening(true)
      void cookrew().listenStart()
    } else if (step.action === 'stop') {
      void cookrew().listenStop()
    }
  }, [])

  useEffect(() => {
    if (!options.enabled || !available) return
    const now = (): number => performance.now()
    const onKeyDown = (e: KeyboardEvent): void =>
      apply(pttStep(stateRef.current, { type: 'keydown', key: e.key, metaKey: e.metaKey, repeat: e.repeat }, now()))
    const onKeyUp = (e: KeyboardEvent): void => apply(pttStep(stateRef.current, { type: 'keyup', key: e.key }, now()))
    const onBlur = (): void => apply(pttStep(stateRef.current, { type: 'blur' }, now()))
    // The hold is measured by polling rather than a one-shot timer so a key
    // released early leaves nothing armed behind it.
    const ticker = window.setInterval(() => {
      if (stateRef.current.phase === 'armed') apply(pttStep(stateRef.current, { type: 'tick', now: now() }, now()))
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
  }, [options.enabled, available, apply])

  useEffect(
    () =>
      cookrew().onListenEvent((event: ListenEvent) => {
        if (event.kind === 'partial') setPartial(event.text)
        if (event.kind === 'final' || event.kind === 'error') {
          setListening(false)
          setPartial('')
          apply(pttStep(stateRef.current, { type: 'ended' }, performance.now()))
          if (event.kind === 'final') onFinalRef.current(event.text, Object.values(event.alternates ?? {}))
          else onErrorRef.current?.(event.message)
        }
      }),
    [apply]
  )

  return { listening, partial, available }
}
