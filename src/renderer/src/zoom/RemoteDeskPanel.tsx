import { memo, useEffect, useSyncExternalStore } from 'react'
import { machineCopy } from '../../../shared/machine-words'
import { remoteView } from '../../../shared/remote-access'
import { cookrew } from '../api'
import { openSourcePicker } from '../use/source-picker-store'
import { remoteWhere, useRemoteAccess, useRemoteActs } from '../use/remote-acts'
import { RemoteConfirmView, RemotePanel } from '../use/RemotePanel'
import { SWITCH_LABEL, SWITCH_MEANS, useRemoteSwitch } from '../use/RemoteSwitch'
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
 */

const DEVICE_STOP_INDEX = 1

const onDevicePage = (zoom: Pick<ZoomState, 'dir' | 'v' | 'full'>): boolean => zoom.full === null && barStop(zoom.dir, zoom.v) === BAR_STOPS[zoom.dir][DEVICE_STOP_INDEX]
const onTheStop = (): boolean => onDevicePage(zoomStore.get())

function Panel(): React.JSX.Element | null {
  const { access, read } = useRemoteAccess(true)
  const settable = typeof cookrew().setRemoteSwitch === 'function'
  const { facts, error, flip } = useRemoteSwitch(settable)
  useEffect(() => {
    const timer = setInterval(() => void read(), 15_000)
    return () => clearInterval(timer)
  }, [read])
  const acts = useRemoteActs({ state: access?.state ?? null, onCheck: read, onOpened: read })
  if (!access) return null
  const { state, control } = access
  const where = remoteWhere()
  const word = (sentence: string): string => machineCopy(sentence, state.platform)
  const on = facts?.switchOn ?? control.switchOn
  return (
    <section className="zv-remote" aria-label="Remote desktop">
      <div className="zv-remote-head">
        <b>Remote desktop</b>
        {state.id === 'ready' && <button type="button" className="zv-remote-open" onClick={() => openSourcePicker({ remoteDesktop: true })}>Open</button>}
      </div>
      {state.id === 'ready' ? <p>{word(remoteView(state, where).sentence)}</p> : <RemotePanel state={state} where={where} busy={acts.busy} note={acts.note} onAct={acts.act} />}
      {control.available && settable && (
        <label className="zv-remote-switch" title={SWITCH_MEANS}>
          <input type="checkbox" role="switch" checked={on} onChange={flip} />
          <span>{SWITCH_LABEL}</span>
        </label>
      )}
      {control.available && settable && on && <p className="zv-remote-means">{SWITCH_MEANS}</p>}
      {control.available && !settable && <p className="zv-remote-means">{word(on ? 'Remote control is on. Take control from a card.' : 'Remote control is off, and only someone at the Mac can turn it on.')}</p>}
      {!control.available && <p className="zv-remote-means">{word('This Mac is view only: it cannot be controlled from here.')}</p>}
      {error && <p className="zv-remote-error" role="alert">{error}</p>}
      {acts.confirm && <RemoteConfirmView confirm={acts.confirm} onYes={() => acts.answerConfirm(true)} onNo={() => acts.answerConfirm(false)} />}
    </section>
  )
}

export const RemoteDeskPanel = memo(function RemoteDeskPanel(): React.JSX.Element | null {
  const shown = useSyncExternalStore(zoomStore.subscribe, onTheStop, onTheStop)
  const reachable = typeof cookrew().remoteAccess === 'function'
  return shown && reachable ? <Panel /> : null
})
