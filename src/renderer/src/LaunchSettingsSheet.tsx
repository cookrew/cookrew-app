// LAUNCH SETTINGS in ⋯: what used to be a launch line, as controls. They are read
// as the app starts and belong to this machine, so where the bridge has no such
// call (the phone, a served page) the row is simply not there.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  LAUNCH_DEFAULTS,
  LAUNCH_ENV,
  LAUNCH_KEYS,
  LAUNCH_MULTIPLEXERS,
  type LaunchKey,
  type LaunchSaveFailure,
  type LaunchSaveResult,
  type LaunchStatus,
  type LaunchValues
} from '../../shared/launch-settings'
import { cookrew } from './api'
import { CrIcon } from './icons'
import './grant-surface.css'
import './launch-settings.css'

const FAILURE: Readonly<Record<LaunchSaveFailure, string>> = {
  'invalid-registry': 'Use an https address.',
  'invalid-choice': 'That choice is not one Cookrew can use.',
  'signed-in': 'Sign out first: your session belongs to the registry you signed in at.',
  'write-failed': 'The settings could not be saved. Nothing changed.',
  'not-owner': 'Only the app’s own window can change these.'
}

const HOST_NAMES: Readonly<Record<string, string>> = {
  herdr: 'herdr: agents outlive the app',
  tmux: 'tmux: agents outlive the app',
  direct: 'Direct: agents end with the app'
}

export interface LaunchSettingsViewProps {
  draft: LaunchValues
  status: LaunchStatus
  saved: boolean
  error: string | null
  busy: boolean
  onDraft: (draft: LaunchValues) => void
  onSave: () => void
  onReset: () => void
  onClose: () => void
}

function Pinned({ name, status }: { name: LaunchKey; status: LaunchStatus }): React.JSX.Element | null {
  if (!status.pinned.includes(name)) return null
  return <p className="gs-hint">Set by {LAUNCH_ENV[name]} for this launch. Start Cookrew without it to change this here.</p>
}

/** A direct host has nothing to move: its agents ended with the last run. */
const movesHost = (draft: LaunchValues, status: LaunchStatus): boolean =>
  !status.pinned.includes('multiplexer') && status.running.multiplexer !== 'direct' && draft.multiplexer !== status.running.multiplexer

const MOVE_NOTE = 'After a restart, each agent moves when its workspace next opens: it is stopped on the old host and resumed on this one, so a turn in progress is lost. Other terminals stay on the old host, and a new one starts beside them.'
const DIRECT_NOTE = 'Agents end when Cookrew quits or its window closes.'

function Switch(props: { name: 'interactiveBrowser' | 'multiInstance'; label: string; note: string } & Pick<LaunchSettingsViewProps, 'draft' | 'status' | 'onDraft'>): React.JSX.Element {
  const { name, label, note, draft, status, onDraft } = props
  return (
    <div className="ls-field">
      <label className="ls-switch">
        <input
          type="checkbox"
          checked={draft[name]}
          disabled={status.pinned.includes(name)}
          onChange={(event) => onDraft({ ...draft, [name]: event.target.checked })}
        />
        <span>{label}</span>
      </label>
      <p className="gs-hint">{note}</p>
      <Pinned name={name} status={status} />
    </div>
  )
}

export function LaunchSettingsView({ draft, status, saved, error, busy, onDraft, onSave, onReset, onClose }: LaunchSettingsViewProps): React.JSX.Element {
  const hosts = [...new Set<string>([...LAUNCH_MULTIPLEXERS, draft.multiplexer])]
  const moves = movesHost(draft, status)
  const edited = LAUNCH_KEYS.some((key) => draft[key] !== status.values[key])
  const registryHeld = status.pinned.includes('registry') || status.signedIn
  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Launch settings">
      <div
        className="gs-sheet gs-small cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Launch settings</h2>
          <button type="button" className="gs-x" onClick={onClose} aria-label="Close" autoFocus>
            ✕
          </button>
        </header>
        <p className="gs-sub">Read as Cookrew starts, so a change takes effect the next time Cookrew starts.</p>
        <div className="ls-field">
          <label className="gs-label" htmlFor="launch-registry">
            Registry
          </label>
          <input
            id="launch-registry"
            className="gs-input"
            value={draft.registry}
            disabled={registryHeld}
            spellCheck={false}
            onChange={(event) => onDraft({ ...draft, registry: event.target.value })}
          />
          <p className="gs-hint">Your account, phones reaching you from anywhere, and served crews all go through it.</p>
          {status.signedIn && <p className="gs-hint">Sign out to change this: your session belongs to this registry.</p>}
          <Pinned name="registry" status={status} />
        </div>
        <div className="ls-field">
          <label className="gs-label" htmlFor="launch-host">
            Terminal host
          </label>
          <select
            id="launch-host"
            className="gs-input"
            value={draft.multiplexer}
            disabled={status.pinned.includes('multiplexer')}
            onChange={(event) => onDraft({ ...draft, multiplexer: event.target.value })}
          >
            {hosts.map((host) => (
              <option key={host} value={host}>
                {HOST_NAMES[host] ?? host}
              </option>
            ))}
          </select>
          {draft.multiplexer !== 'direct' && <p className="gs-hint">Tried first. If it is not installed, Cookrew falls back to the next one.</p>}
          {draft.multiplexer === 'direct' && <p className="gs-hint">{DIRECT_NOTE}</p>}
          {moves && <p className="gs-hint">{MOVE_NOTE}</p>}
          <Pinned name="multiplexer" status={status} />
        </div>
        <Switch name="multiInstance" label="Run workspaces independently" note="Off: Cookrew holds one workspace at a time and drops the one you leave, though agents there keep running. Workspaces lose their own addresses, served crews stop answering, and a phone that switches workspace moves this window too." draft={draft} status={status} onDraft={onDraft} />
        <Switch name="interactiveBrowser" label="Run pages in Chrome" note="On: pages run in a background Chrome, keep going in workspaces you are not in, and a phone can watch and use them live. Off: pages live in this window, and a phone only sees pictures of them. Needs Chrome, Chromium or Edge; without one this stays off." draft={draft} status={status} onDraft={onDraft} />
        {error !== null && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}
        {!edited && (saved || status.restart) && <p className="gs-hint">{status.restart ? 'Saved. Restart Cookrew to use these.' : 'Saved.'}</p>}
        <div className="gs-sheet-foot">
          <button type="button" className="gs-ghost" onClick={onReset} disabled={busy}>
            Use defaults
          </button>
          <button type="button" className="gs-primary" onClick={onSave} disabled={busy}>
            {moves ? 'Save and move agents' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function LaunchSettingsSheet({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const [status, setStatus] = useState<LaunchStatus | null>(null)
  const [draft, setDraft] = useState<LaunchValues | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const take = (next: LaunchStatus): void => {
    setStatus(next)
    setDraft(next.values)
  }

  useEffect(() => {
    let alive = true
    void cookrew()
      .launchSettings?.()
      .then((next) => {
        if (!alive) return
        if (next) take(next)
        else onClose()
      })
      // Nothing to show: closing leaves the row able to try again.
      .catch(() => onClose())
    return () => {
      alive = false
    }
  }, [onClose])

  // On the window as well: a pressed button goes disabled while saving, focus falls to
  // the body, and the sheet's own handler no longer hears the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (status === null || draft === null) return null

  const edit = (next: LaunchValues): void => {
    setDraft(next)
    setSaved(false)
    setError(null)
  }

  const save = (): void => {
    setBusy(true)
    setError(null)
    void cookrew()
      .saveLaunchSettings?.(draft)
      .then((result: LaunchSaveResult) => {
        if (!result.ok) return setError(FAILURE[result.reason])
        take(result.status)
        setSaved(true)
      })
      .catch(() => setError(FAILURE['write-failed']))
      .finally(() => setBusy(false))
  }

  // Into the draft, not the file: going back to herdr moves agents like any other
  // change, so it passes the same warning and the same button. What a variable or a
  // session holds stays as it is.
  const reset = (): void => {
    const held = (key: LaunchKey): boolean => status.pinned.includes(key) || (key === 'registry' && status.signedIn)
    edit({ ...LAUNCH_DEFAULTS, ...Object.fromEntries(LAUNCH_KEYS.filter(held).map((key) => [key, draft[key]])) })
  }

  return createPortal(
    <LaunchSettingsView draft={draft} status={status} saved={saved} error={error} busy={busy} onDraft={edit} onSave={save} onReset={reset} onClose={onClose} />,
    document.body
  )
}

export function LaunchSettingsRow({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  if (cookrew().launchSettings === undefined) return null
  return (
    <button type="button" className="cr-more-item" onClick={onOpen}>
      <CrIcon name="terminal" />
      <span className="cr-more-label">Launch settings</span>
    </button>
  )
}
