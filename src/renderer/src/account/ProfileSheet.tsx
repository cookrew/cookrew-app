import { useEffect, useState } from 'react'
import type { AccountProfile, AccountStatus } from '../../../shared/account-v2'
import type { WorkspaceMeta } from '../../../shared/model'
import { cookrew } from '../api'
import {
  ACCOUNT_COPY,
  deviceName,
  initialsOf,
  refusalSentence,
  revokeSentence,
} from './account-store'
import { SecurityCard } from './SecurityCard'
import { securityActions } from './security-actions'
import '../grant-surface.css'

/**
 * THE PROFILE SHEET (D4) — five tabs, and Devices is the heart of it.
 *
 * Everything shown here is a DIRECTORY FACT (architecture P1): who the account
 * is, which devices hold a key, which workspaces this Mac has registered BY
 * NAME. No canvas content leaves the desktop, and the Workspaces tab says so
 * in its own words rather than leaving the reader to assume it.
 *
 * WHAT IS NOT HERE, deliberately: nothing in this phase can approve a device
 * (D6, phase 4), buy a seat (phase 5) or reach another desktop (phase 3). The
 * tabs for those exist and are honest about being empty. An empty tab that
 * says "No seats yet." is a promise about where the thing will appear; a tab
 * that is missing is a feature the person cannot find later.
 */

export const PROFILE_TABS = [
  'PROFILE',
  'DEVICES',
  'SECURITY',
  'WORKSPACES',
  'SEATS & TEAMS',
] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

const KIND_LABEL: Record<string, string> = {
  desktop: 'DESKTOP',
  phone: 'PHONE',
  browser: 'BROWSER',
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 2) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function ProfileSheet({
  status,
  initialTab = 'PROFILE',
  onClose,
  onStatus,
}: {
  status: AccountStatus
  initialTab?: ProfileTab
  onClose: () => void
  onStatus: (next: AccountStatus) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<ProfileTab>(initialTab)
  /** THIS MAC'S workspaces, read from the store the canvas already uses —
   *  names and ids, which is all that ever leaves the desktop (P1). */
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceMeta[]>([])
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The display name while it is being edited; null when it is not. */
  const [editing, setEditing] = useState<string | null>(null)
  const username = status.username ?? ''

  useEffect(() => {
    void cookrew()
      .listWorkspaces()
      .then((list) => setWorkspaces(list.workspaces))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const call = cookrew().accountProfile
    if (!call) return
    void call()
      .then((result) => {
        if (result.ok) setProfile(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        console.error('profile sheet:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }, [username])

  const revoke = (id: string): void => {
    const call = cookrew().accountRevoke
    if (!call) return
    setConfirming(null)
    void call(id)
      .then((result) => {
        if (!result.ok) {
          setError(refusalSentence(result.reason, result.message, username))
          return
        }
        setProfile((prior) =>
          prior ? { ...prior, devices: prior.devices.filter((d) => d.id !== id) } : prior,
        )
      })
      .catch((err: unknown) => {
        console.error('revoke device:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  /**
   * The display name is the ONE profile fact this phase can change.
   *
   * Saved on its own, not as part of a form: nothing else on this tab is
   * editable, so a SAVE that implied otherwise would be lying about its scope.
   */
  const saveName = (next: string): void => {
    const call = cookrew().accountSetProfile
    setEditing(null)
    if (!call) return
    void call({ displayName: next.trim() })
      .then((result) => {
        if (result.ok) setProfile(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        console.error('set display name:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  const setReachable = (on: boolean): void => {
    const call = cookrew().accountWorkspacesReachable
    if (!call) return
    void call(on)
      .then(onStatus)
      .catch(() => undefined)
  }

  const now = Date.now()
  return (
    <div
      className="gs-scrim cr-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Profile @${username}`}
    >
      <div
        className="gs-sheet cr-acct-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <div className="cr-acct-who">
            <span className="cr-acct-avatar cr-acct-claimed cr-acct-big">
              <span className="cr-acct-initials">{initialsOf(username, status.displayName)}</span>
            </span>
            <h2>@{username.toUpperCase()}</h2>
          </div>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <nav className="cr-acct-tabs" role="tablist" aria-label="Profile">
          {PROFILE_TABS.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              className="cr-acct-tab"
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>

        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}

        {tab === 'PROFILE' && (
          <section className="cr-acct-pane" aria-label="Profile">
            {editing === null ? (
              <p className="gs-sub">
                {profile?.displayName || username}
                {profile
                  ? ` · member since ${new Date(profile.claimedAt).toLocaleDateString()}`
                  : ''}{' '}
                <button className="gs-ghost" onClick={() => setEditing(profile?.displayName ?? '')}>
                  EDIT
                </button>
              </p>
            ) : (
              <div className="cr-acct-row">
                <input
                  className="gs-input"
                  autoFocus
                  aria-label="Display name"
                  placeholder="Your name"
                  value={editing}
                  onChange={(e) => setEditing(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName(editing)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
                <button className="gs-primary" onClick={() => saveName(editing)}>
                  SAVE
                </button>
              </div>
            )}
            {status.envUsername && status.envUsername !== username && (
              /* Phase 6 migrates identity; today's door keeps the env handle,
                 and saying so is better than two names and no explanation. */
              <p className="gs-foot-note">
                This Mac serves as @{status.envUsername} (from COOKREW_HANDLE). Serving moves onto
                your account in a later phase.
              </p>
            )}
          </section>
        )}

        {tab === 'DEVICES' && (
          <section className="cr-acct-pane" aria-label="Devices">
            <ul className="cr-acct-devices">
              {(profile?.devices ?? []).map((device) => (
                <li key={device.id} className="cr-acct-device">
                  <span className="cr-acct-kind">{KIND_LABEL[device.kind] ?? 'DEVICE'}</span>
                  <span className="cr-acct-seclabel">{deviceName(device.name)}</span>
                  {device.current ? (
                    <span className="cr-acct-secstate">THIS DEVICE</span>
                  ) : (
                    <>
                      <span className="cr-acct-secstate">
                        LAST SEEN {ago(device.lastSeenAt, now)}
                      </span>
                      <button className="gs-revoke" onClick={() => setConfirming(device.id)}>
                        REVOKE
                      </button>
                    </>
                  )}
                  {confirming === device.id && (
                    <p className="gs-consequence">
                      {revokeSentence(deviceName(device.name))}{' '}
                      <button className="gs-revoke" onClick={() => revoke(device.id)}>
                        REVOKE IT
                      </button>
                    </p>
                  )}
                </li>
              ))}
              {profile !== null && profile.devices.length === 0 && (
                <li className="gs-dim">No devices listed yet.</li>
              )}
            </ul>
          </section>
        )}

        {tab === 'SECURITY' && (
          <SecurityCard
            username={username}
            lockAfterMs={status.lockAfterMs}
            recoveryCodesSavedAt={status.recoveryCodesSavedAt}
            recoveryCodesLeft={profile?.recoveryCodesLeft ?? status.recoveryCodesLeft}
            {...securityActions(onStatus, onClose)}
          />
        )}

        {tab === 'WORKSPACES' && (
          <section className="cr-acct-pane" aria-label="Workspaces">
            <ul className="cr-acct-workspaces">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>{workspace.name}</li>
              ))}
              {workspaces.length === 0 && <li className="gs-dim">No workspaces on this Mac.</li>}
            </ul>
            <label className="cr-acct-toggle">
              <input
                type="checkbox"
                checked={status.workspacesReachable}
                onChange={(e) => setReachable(e.target.checked)}
              />
              Reachable from my other devices
            </label>
            <p className="gs-foot-note">{ACCOUNT_COPY.WORKSPACES_NOTE}</p>
          </section>
        )}

        {tab === 'SEATS & TEAMS' && (
          <section className="cr-acct-pane" aria-label="Seats and teams">
            {/* Phase 5 fills this. The tab exists so the person knows where a
                seat will appear, rather than looking for it and finding no tab. */}
            <p className="gs-dim">{ACCOUNT_COPY.NO_SEATS}</p>
          </section>
        )}
      </div>
    </div>
  )
}
