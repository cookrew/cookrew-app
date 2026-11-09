import { useCallback, useEffect } from 'react'
import { REMOTE_SETUP_COPY as COPY } from '../../../shared/first-run-copy'
import type { RemoteAccess, RemoteAction, RemoteState } from '../../../shared/remote-access'
import { remoteView } from '../../../shared/remote-access'
import { cookrew } from '../api'
import { useRemoteAccess, useRemoteActs } from '../use/remote-acts'
import { RemoteConfirmView } from '../use/RemotePanel'
import { useRemoteSwitch } from '../use/RemoteSwitch'
import './first-run.css'

/**
 * REMOTE DESKTOP, OFFERED ON DAY ONE. Optional: it stands in nobody's way, and only
 * a Mac shows it: its rows are the Mac's grants. The phone sees nothing here, and
 * Linux has its xdotool row in the tool check and its switch in ⋯.
 *
 * The two grants are the system's and each has a press of its own. The switch is
 * the same one as in ⋯, behind the same confirmation at the machine. All of it is
 * read from the desk, so this says what the card says.
 */

export type RemoteGrant = 'on' | 'off' | 'restart'

export interface RemoteSteps {
  readonly screen: RemoteGrant
  readonly accessibility: 'on' | 'off'
  readonly on: boolean
}

/** A lock and a sleeping display say nothing of the grant, so what comes after them does. */
export function effectiveRemoteState(access: RemoteAccess): RemoteState {
  const { state } = access
  return state.id === 'locked' && state.then !== null ? { ...state, id: state.then, then: null } : state
}

export function remoteRestartAction(access: RemoteAccess): RemoteAction | null {
  return remoteView(effectiveRemoteState(access), 'here').actions.find((candidate) => candidate.id === 'restart') ?? null
}

export function remoteSteps(access: RemoteAccess): RemoteSteps {
  const stands = effectiveRemoteState(access).id
  const screen: RemoteGrant = stands === 'needs-screen-recording' ? 'off' : stands === 'needs-restart' ? 'restart' : 'on'
  return { screen, accessibility: access.control.accessibility ? 'on' : 'off', on: access.control.switchOn }
}

export interface RemoteRowsViewProps {
  access: RemoteAccess
  busy: boolean
  /** What the last press said. */
  said: string | null
  onOpen: (pane: 'screen' | 'accessibility') => void
  onRestart: () => void
  onSwitch: (on: boolean) => void
}

const WORD: Readonly<Record<RemoteGrant, string>> = { on: COPY.ON, off: COPY.OFF, restart: COPY.RESTART_NEEDED }

function Step(props: { name: string; does: string; grant: RemoteGrant; settingsName: string; busy: boolean; press: { label: string; run: () => void } | null }): React.JSX.Element {
  const { name, does, grant, settingsName, busy, press } = props
  return (
    <li className={`fr-row ${grant === 'on' ? 'found' : 'missing'}`}>
      <span className="fr-dot" aria-hidden="true" />
      <span className="fr-tool">
        <b>{name}</b>
        <small>{does}</small>
        {grant === 'off' && <small className="fr-note">{COPY.TURN_ON_ROW(settingsName)} {COPY.STALE}</small>}
      </span>
      <span className="fr-act">
        <span className="fr-state">{WORD[grant]}</span>
        {press && (
          <button type="button" className="fr-fix" disabled={busy} onClick={press.run}>
            {press.label}
          </button>
        )}
      </span>
    </li>
  )
}

export function RemoteRowsView({ access, busy, said, onOpen, onRestart, onSwitch }: RemoteRowsViewProps): React.JSX.Element {
  const steps = remoteSteps(access)
  const { settingsName } = access.state.build
  const canRestart = access.state.build.restart === 'self'
  const screenPress = steps.screen === 'off' ? { label: COPY.ALLOW, run: () => onOpen('screen') } : steps.screen === 'restart' && canRestart ? { label: COPY.RESTART, run: onRestart } : null
  return (
    <div className="fr-access fr-remote">
      <h2 className="fr-access-head">
        {COPY.HEAD} <span className="fr-optional">{COPY.OPTIONAL}</span>
      </h2>
      <p className="fr-remote-lede">{COPY.LEDE}</p>
      <ul className="fr-rows">
        <Step name={COPY.SCREEN_NAME} does={COPY.SCREEN_DOES} grant={steps.screen} settingsName={settingsName} busy={busy} press={screenPress} />
        <Step name={COPY.ACCESSIBILITY_NAME} does={COPY.ACCESSIBILITY_DOES} grant={steps.accessibility} settingsName={settingsName} busy={busy} press={steps.accessibility === 'off' ? { label: COPY.ALLOW, run: () => onOpen('accessibility') } : null} />
        <li className={`fr-row ${steps.on ? 'found' : 'missing'}`}>
          <span className="fr-dot" aria-hidden="true" />
          <span className="fr-tool">
            <b>{COPY.SWITCH_NAME}</b>
            <small>{COPY.SWITCH_DOES}</small>
          </span>
          <span className="fr-act">
            <span className="fr-state">{steps.on ? COPY.ON : COPY.OFF}</span>
            <button type="button" className="fr-fix" disabled={busy} onClick={() => onSwitch(!steps.on)}>
              {steps.on ? COPY.TURN_OFF : COPY.TURN_ON}
            </button>
          </span>
        </li>
      </ul>
      {said && (
        <p className="fr-remote-said" role="status">
          {said}
        </p>
      )}
    </div>
  )
}

const OPEN: Readonly<Record<'screen' | 'accessibility', RemoteAction>> = {
  screen: { id: 'open-screen-settings', label: COPY.ALLOW },
  accessibility: { id: 'open-accessibility-settings', label: COPY.ALLOW }
}

export function RemoteRows(): React.JSX.Element | null {
  const settable = typeof cookrew().setRemoteSwitch === 'function'
  const { access, read } = useRemoteAccess(settable)
  const { error, busy: switchBusy, flip } = useRemoteSwitch(settable, () => void read())
  const acts = useRemoteActs({ state: access?.state ?? null, onCheck: read })
  // Back from System Settings is when a grant has changed.
  useEffect(() => {
    if (!settable) return
    const again = (): void => void read()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [read, settable])
  const restart = useCallback((): void => {
    const action = access ? remoteRestartAction(access) : null
    if (action) acts.act(action)
  }, [access, acts])
  if (!settable || !access?.control.available || access.state.platform !== 'darwin') return null
  return (
    <>
      <RemoteRowsView access={access} busy={acts.busy || switchBusy} said={error ?? acts.note} onOpen={(pane) => acts.act(OPEN[pane])} onRestart={restart} onSwitch={flip} />
      {acts.confirm && <RemoteConfirmView confirm={acts.confirm} onYes={() => acts.answerConfirm(true)} onNo={() => acts.answerConfirm(false)} />}
    </>
  )
}
