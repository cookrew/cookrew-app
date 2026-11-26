import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { GUEST_REPORT_CHANNEL, GUEST_COMMAND_CHANNEL, MACHINE_GUEST_PARTITION, machineGuestUrl, parseGuestReport } from '../../../shared/machine-guest'
import { themeNow } from '../color-scheme'
import { cookrew } from '../api'
import { ENTRY_MS, entryFrom } from './remote-entry'
import { remotePlace, type RemotePlace } from './remote-machine-store'
import './machine-guest.css'

/**
 * ANOTHER MACHINE, INSIDE THIS WINDOW, AS THE CONSOLE DRAWS IT (owner
 * 2026-11-25). Entered in place from its frame on the devices stop (ZoomView ·
 * MachineFrame), or from a face of it on the bar (remote-open.ts): that
 * machine's whole app, in a <webview> of its own (guest/GuestMachine.tsx), so
 * its agents are worked exactly as this machine's are. It replaces the tiles and
 * the card this window used to draw of it from the watch's routes.
 *
 * This window keeps its title line (HeaderRoute.tsx names the guest's place and
 * steps through it); the guest has its own stage, bar and box. Its outermost
 * stop is this window's devices stop: going there leaves the machine.
 */

/** Electron's <webview>, as much of it as this needs. */
type GuestElement = HTMLElement & { send: (channel: string, ...args: unknown[]) => void }

type Opening = 'opening' | 'open' | 'failed'

const read = (): RemotePlace => remotePlace.get()

/** Chromium's "the load was replaced by another": not a failure of the page. */
const ABORTED = -3

export function MachineGuestView(): React.JSX.Element | null {
  const place = useSyncExternalStore(remotePlace.subscribe, read, read)
  const machine = place.machine
  const stage = useRef<HTMLElement | null>(null)
  const guest = useRef<GuestElement | null>(null)
  const [opening, setOpening] = useState<Opening>('opening')
  const visit = machine ? `${machine.id}:${place.visit}` : null

  // ENTERED IN PLACE: the view opens out of the machine's own frame on the devices stop, from
  // where that frame stood. Once a visit, and not at all for someone who asked for less motion.
  const from = machine?.from
  useLayoutEffect(() => {
    setOpening('opening')
    const el = stage.current
    if (!el || !from || typeof el.animate !== 'function') return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const box = el.getBoundingClientRect()
    const first = entryFrom(from, { x: box.left, y: box.top, w: box.width, h: box.height })
    if (first === null) return
    el.animate([{ clipPath: first.from, opacity: 0.6 }, { clipPath: first.to, opacity: 1 }], { duration: ENTRY_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' })
    // `from` is where the frame stood at the moment of entry: read once, with the visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit])

  // THE OWNER'S LOCK TAKES THE MACHINE DOWN: nothing of it stays live under the lock's veil, and main
  // cuts what it still carried (main/machine-guest.ts). Unlocked, the window stands where it left it.
  const inside = machine !== null
  useEffect(() => {
    if (!inside) return undefined
    return cookrew().onAccountLocked?.((locked) => {
      if (locked) remotePlace.leave()
    })
  }, [inside])

  // What the guest says, and the title line's steps sent on to it.
  useEffect(() => {
    const el = guest.current
    if (!el || visit === null) return undefined
    const onMessage = (event: Event): void => {
      const { channel, args } = event as Event & { channel?: unknown; args?: unknown[] }
      if (channel !== GUEST_REPORT_CHANNEL) return
      const report = parseGuestReport(args?.[0])
      if (report) remotePlace.heard(report)
    }
    const onReady = (): void => {
      setOpening('open')
      // The keys go to the machine now on show: Esc steps out through its own stops.
      el.focus()
    }
    const onFailed = (event: Event): void => {
      const { errorCode, isMainFrame } = event as Event & { errorCode?: number; isMainFrame?: boolean }
      if (isMainFrame === false || errorCode === ABORTED) return
      setOpening('failed')
    }
    const onGone = (): void => setOpening('failed')
    el.addEventListener('ipc-message', onMessage)
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-fail-load', onFailed)
    el.addEventListener('render-process-gone', onGone)
    const offCommand = remotePlace.onCommand((command) => {
      try {
        el.send(GUEST_COMMAND_CHANNEL, command)
      } catch {
        // Not attached yet, or already gone: a step asked of no page goes nowhere.
      }
    })
    return () => {
      offCommand()
      el.removeEventListener('ipc-message', onMessage)
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-fail-load', onFailed)
      el.removeEventListener('render-process-gone', onGone)
    }
  }, [visit])

  // Once a visit: the page is the visit's, and a later render (a crumb heard, a theme changed) never reloads it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const src = useMemo(() => (machine ? machineGuestUrl(machine.id, place.entry, themeNow()) : null), [visit])
  if (!machine || src === null) return null

  return (
    <section ref={stage} className="mg-stage" data-state={opening} aria-label={`${machine.name}, another machine of your account`}>
      <webview
        key={visit ?? ''}
        ref={(el: unknown) => {
          guest.current = el as GuestElement | null
        }}
        className="mg-view"
        partition={MACHINE_GUEST_PARTITION}
        src={src}
      />
      {opening === 'opening' && (
        <p className="mg-note" role="status">
          Opening {machine.name}…
        </p>
      )}
      {opening === 'failed' && (
        <div className="mg-note" role="alert">
          <span>{machine.name}’s view could not be opened here.</span>
          <button type="button" onClick={() => remotePlace.leave()}>
            Back to devices
          </button>
        </div>
      )}
    </section>
  )
}
