import { useEffect, useState, useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { requestAccountSheet } from '../account/open-request'
import { useMagpieSwitches } from './MagpieSwitches'
import { magpieRemoteStoreFor, type MagpieRemoteState, type MagpieRemoteStore } from './magpie-remote-store'
import { DEVICES_COPY as COPY, guideSteps, harnessLines, type GuideDesktop, type GuideStep } from '../../../shared/devices-guide'
import type { LiveValues } from '../../../shared/launch-settings'
import './devices-guide.css'

/**
 * YOUR COMPUTERS, ONE MODEL LOGIN (shared/devices-guide.ts): add computers to the
 * account, put an agent on each, log into a model on one, use it from the rest.
 * Drawn in the first run and in Launch settings; its state lives in
 * magpie-remote-store.ts, so a sheet that closes mid-connect loses nothing.
 */

function CopyLine({ line }: { line: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <span className="cr-devices-line">
      <code>{line}</code>
      <button type="button" className="cr-routing-btn" onClick={() => void navigator.clipboard?.writeText(line).then(() => setCopied(true)).catch(() => setCopied(false))}>
        {copied ? COPY.COPIED : COPY.COPY}
      </button>
    </span>
  )
}

function Step({ step, title, does, children }: { step: GuideStep | undefined; title: string; does: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <li className="cr-devices-step" data-step={step?.id} data-done={step?.done === null ? 'unknown' : step?.done === true}>
      <b>{title}</b>
      <small>{does}</small>
      {step?.blocked && <small className="cr-routing-bad">{step.blocked}</small>}
      {children}
    </li>
  )
}

function UseRow({ desktop, busy, blocked, problem, onUse, onStop }: { desktop: GuideDesktop; busy: boolean; blocked: boolean; problem: string | undefined; onUse: () => void; onStop: () => void }): React.JSX.Element {
  return (
    <div className="cr-devices-use" data-peer={desktop.id}>
      <span>
        <b>{desktop.name}</b> <small>{desktop.online ? COPY.ONLINE : COPY.OFFLINE}</small>
      </span>
      {desktop.providerId !== null ? (
        <span>
          <small>{COPY.USING(desktop.providerId)}</small>{' '}
          <button type="button" className="cr-routing-btn" disabled={busy} onClick={onStop}>
            {COPY.STOP}
          </button>
        </span>
      ) : (
        <button type="button" className="cr-routing-btn primary" disabled={busy || blocked || !desktop.online} onClick={onUse}>
          {busy ? COPY.CONNECTING : COPY.USE}
        </button>
      )}
      {problem && (
        <small className="cr-routing-bad" role="alert">
          {problem}
        </small>
      )}
    </div>
  )
}

export function DevicesGuideView({ state, switches, modelHere, model, onUse, onStop, onAccount }: { state: MagpieRemoteState; switches: LiveValues | null; modelHere: boolean | null; model?: React.ReactNode; onUse: (d: GuideDesktop) => void; onStop: (d: GuideDesktop) => void; onAccount: () => void }): React.JSX.Element {
  const list = state.list
  const desktops = list?.desktops ?? []
  const steps = guideSteps({ signedIn: list?.signedIn ?? false, desktops, modelHere, switches })
  const at = (id: GuideStep['id']): GuideStep | undefined => steps.find((s) => s.id === id)
  const useBlocked = at('use')?.blocked !== null
  return (
    <section className="cr-devices" aria-label={COPY.HEAD}>
      <div className="cr-routing-seg">{COPY.HEAD}</div>
      <p className="small">{COPY.LEDE}</p>
      {state.readProblem && <p className="cr-routing-bad">{state.readProblem}</p>}
      <ol className="cr-devices-steps">
        <Step step={at('computers')} title={COPY.STEP_COMPUTERS} does={COPY.STEP_COMPUTERS_DOES}>
          <ul className="cr-devices-list">
            <li>
              <b>{COPY.THIS}</b>
            </li>
            {desktops.length === 0 ? <li className="small">{COPY.NONE}</li> : desktops.map((d) => <li key={d.id}>{d.name} <small>{d.online ? COPY.ONLINE : COPY.OFFLINE}</small></li>)}
          </ul>
          <button type="button" className="cr-routing-btn" onClick={onAccount}>
            {list?.signedIn ? COPY.ADD : COPY.SIGN_IN}
          </button>
        </Step>
        <Step step={at('agents')} title={COPY.STEP_AGENTS} does={COPY.STEP_AGENTS_DOES}>
          {desktops.map((d) => (
            <div key={d.id} className="cr-devices-agents">
              <b>{d.name}</b>
              {harnessLines(d.os, d.arch).map((h) => (
                <div key={h.harness}>
                  <small>{h.name}</small> {h.line === null ? <small>{COPY.NO_LINE}</small> : <CopyLine line={h.line} />}
                </div>
              ))}
            </div>
          ))}
        </Step>
        <Step step={at('model')} title={COPY.STEP_MODEL} does={COPY.STEP_MODEL_DOES}>
          {modelHere === null && <small>Model availability is hidden on this device.</small>}
          {model}
        </Step>
        <Step step={at('use')} title={COPY.STEP_USE} does={COPY.STEP_USE_DOES}>
          {desktops.map((d) => (
            <UseRow key={d.id} desktop={d} busy={state.busy.includes(d.id)} blocked={useBlocked} problem={state.problems[d.id]} onUse={() => onUse(d)} onStop={() => onStop(d)} />
          ))}
          {list && list.forwarder === null && <small className="cr-routing-bad">{COPY.NO_FORWARDER}</small>}
          {list && !list.sealed && desktops.some((d) => d.providerId !== null) && <small>{COPY.NOT_SEALED}</small>}
        </Step>
      </ol>
    </section>
  )
}

export function DevicesGuideBound({ store, modelHere, model }: { store: MagpieRemoteStore; modelHere: boolean | null; model?: React.ReactNode }): React.JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const switches = useMagpieSwitches().values
  useEffect(() => {
    void store.read()
  }, [store])
  // Magpie switched off: nothing here applies (the switch above says how to turn it on).
  if (switches?.magpie === false) return null
  return (
    <DevicesGuideView
      state={state}
      switches={switches}
      modelHere={modelHere}
      model={model}
      onUse={(d) => void store.connect(d.id, d.name)}
      onStop={(d) => void store.disconnect(d.id)}
      onAccount={() => void requestAccountSheet('devices')}
    />
  )
}

/** Absent where the bridge cannot list the account's computers: the phone and an older desktop. */
export function DevicesGuide({ modelHere, model }: { modelHere: boolean | null; model?: React.ReactNode }): React.JSX.Element | null {
  // Rendered where there is no window (a server render, a test): nothing to list from, so no guide.
  if (typeof window === 'undefined') return null
  const bridge = cookrew()
  if (typeof bridge.magpieRemoteList !== 'function') return null
  return <DevicesGuideBound store={magpieRemoteStoreFor(bridge)} modelHere={modelHere} model={model} />
}
