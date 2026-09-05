import { useEffect, useState } from 'react'
import type { AccountProfile, AccountStatus, AdmittedPhone } from '../../../shared/account-v2'
import type { WorkspaceMeta } from '../../../shared/model'
import { cookrew } from '../api'
import { ACCOUNT_COPY, initialsOf, refusalSentence, revokeSentence } from './account-store'
import { PairPhoneSheet } from './PairPhoneSheet'
import { SecurityCard } from './SecurityCard'
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
  const [admitted, setAdmitted] = useState<readonly AdmittedPhone[]>([])
  const [pairing, setPairing] = useState(false)
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

  useEffect(() => {
    const call = cookrew().accountAdmittedDevices
    if (!call) return
    void call()
      .then(setAdmitted)
      .catch(() => undefined)
  }, [pairing])

  /**
   * FORGET, and why it is not REVOKE. This drops the admission on this Mac —
   * the phone has to be admitted here again — and leaves the account's device
   * list alone. Revoking a device at cookrew.dev is a heavier act with its own
   * button a few rows up, and conflating the two would mean one tap doing
   * something the label did not say.
   */
  const forget = (deviceId: string): void => {
    const call = cookrew().accountForgetAdmitted
    if (!call) return
    setAdmitted((prior) => prior.filter((phone) => phone.deviceId !== deviceId))
    void call(deviceId).catch((err: unknown) => console.error('forget admitted:', err))
  }

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

  const setLock = (ms: number): void => {
    const call = cookrew().accountSetLock
    if (!call) return
    void call(ms)
      .then(onStatus)
      .catch(() => undefined)
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
            <p className="gs-sub">
              {profile?.displayName || username}
              {profile ? ` · member since ${new Date(profile.claimedAt).toLocaleDateString()}` : ''}
            </p>
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
            <button className="gs-revoke" onClick={() => setPairing(true)}>
              PAIR A PHONE
            </button>
            <ul className="cr-acct-devices">
              {(profile?.devices ?? []).map((device) => (
                <li key={device.id} className="cr-acct-device">
                  <span className="cr-acct-kind">{KIND_LABEL[device.kind] ?? 'DEVICE'}</span>
                  <span className="cr-acct-seclabel">{device.name}</span>
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
                      {revokeSentence(device.name)}{' '}
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
            {/* ADMITTED PHONES ARE A DIFFERENT KIND OF FACT and get their own
                heading rather than being mixed in. The list above is the
                ACCOUNT's devices, known to cookrew.dev and revocable there;
                this list is local — phones THIS Mac opens for. FORGET drops
                the admission here and nothing else, which is why it is not
                called REVOKE. */}
            {admitted.length > 0 && (
              <>
                <p className="cr-acct-devices-heading">Admitted on this Mac</p>
                <ul className="cr-acct-devices">
                  {admitted.map((phone) => (
                    <li key={phone.deviceId} className="cr-acct-device cr-acct-local">
                      <span className="cr-acct-kind">PHONE</span>
                      <span className="cr-acct-seclabel">{phone.name ?? phone.deviceId}</span>
                      <span className="cr-acct-secstate">
                        LAST SEEN {ago(phone.lastSeenAt, now)}
                      </span>
                      <button className="gs-revoke" onClick={() => forget(phone.deviceId)}>
                        FORGET
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="gs-hint">
                  Forgetting is local: the phone stays on the account and has to be admitted
                  here again.
                </p>
              </>
            )}
            {pairing && <PairPhoneSheet onClose={() => setPairing(false)} />}
          </section>
        )}

        {tab === 'SECURITY' && (
          <SecurityCard
            username={username}
            lockAfterMs={status.lockAfterMs}
            onLockAfterMs={setLock}
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
