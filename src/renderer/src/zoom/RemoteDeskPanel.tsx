import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { machineCopy } from '../../../shared/machine-words'
import { remoteView } from '../../../shared/remote-access'
import { cookrew } from '../api'
import { openSourcePicker } from '../use/source-picker-store'
import { remoteWhere, useRemoteAccess, useRemoteActs } from '../use/remote-acts'
import { RemoteConfirmView, RemotePanel } from '../use/RemotePanel'
import { switchWords, useRemoteSwitch } from '../use/RemoteSwitch'
import { barStop, BAR_STOPS } from './zoom-path'
import { zoomStore, type ZoomState } from './zoom-store'
import './remote-desk.css'

/**
 * THE MACHINE'S OWN REMOTE DESKTOP LINE, on the device page.
 *
 * In screen pixels and out of the scene, like the gauges: inside the machine it
 * would be drawn at a quarter size. Off the stop nothing is mounted, which is
 * also what stops the asking. The state is the one the card shows, and the
 * switch is here only where it can be changed: at the Mac.
 *
 * One line until pressed: this is the page workspaces are chosen from, and a
 * panel standing open covers the tiles. The line says the state, so nothing
 * has to be opened to learn it.
 */

const DEVICE_STOP_INDEX = 1

const onDevicePage = (zoom: Pick<ZoomState, 'dir' | 'v' | 'full'>): boolean => zoom.full === null && barStop(zoom.dir, zoom.v) === BAR_STOPS[zoom.dir][DEVICE_STOP_INDEX]
const onTheStop = (): boolean => onDevicePage(zoomStore.get())

function Panel(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { access, read } = useRemoteAccess(true)
  const settable = typeof cookrew().setRemoteSwitch === 'function'
  const { error, flip } = useRemoteSwitch(settable, () => void read())
  useEffect(() => {
    const timer = setInterval(() => void read(), 15_000)
    return () => clearInterval(timer)
  }, [read])
  const acts = useRemoteActs({ state: access?.state ?? null, onCheck: read, onOpened: read })
  if (!access) return null
  const { state, control } = access
  const where = remoteWhere()
  const word = (sentence: string): string => machineCopy(sentence, state.platform)
  const { label, means } = switchWords(state.platform)
  const on = control.switchOn
  return (
    <section className="zv-remote" data-open={open ? '' : undefined} aria-label="Remote desktop">
      <button type="button" className="zv-remote-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>Remote desktop</b>
        <span>{state.id === 'ready' ? (on ? 'Remote control on' : 'View only') : word(remoteView(state, where).title)}</span>
        <i aria-hidden="true">{open ? '×' : '›'}</i>
      </button>
      {open && (state.id === 'ready' ? (
        <>
          <p>{word(remoteView(state, where).sentence)}</p>
          <button type="button" className="zv-remote-open" onClick={() => openSourcePicker({ remoteDesktop: true })}>Open the screen</button>
        </>
      ) : <RemotePanel state={state} where={where} busy={acts.busy} note={acts.note} onAct={acts.act} />)}
      {open && control.available && settable && (
        <label className="zv-remote-switch" title={means}>
          <input type="checkbox" role="switch" checked={on} onChange={(event) => flip(event.target.checked)} />
          <span>{label}</span>
        </label>
      )}
      {open && control.available && settable && on && <p className="zv-remote-means">{means}</p>}
      {open && control.available && !settable && <p className="zv-remote-means">{word(on ? 'Remote control is on. Take control from a card.' : 'Remote control is off, and only someone at the Mac can turn it on.')}</p>}
      {open && !control.available && <p className="zv-remote-means">{word('This Mac is view only: it cannot be controlled from here.')}</p>}
      {open && error && <p className="zv-remote-error" role="alert">{error}</p>}
      {acts.confirm && <RemoteConfirmView confirm={acts.confirm} onYes={() => acts.answerConfirm(true)} onNo={() => acts.answerConfirm(false)} />}
    </section>
  )
}

export const RemoteDeskPanel = memo(function RemoteDeskPanel(): React.JSX.Element | null {
  const shown = useSyncExternalStore(zoomStore.subscribe, onTheStop, onTheStop)
  const reachable = typeof cookrew().remoteAccess === 'function'
  return shown && reachable ? <Panel /> : null
})
