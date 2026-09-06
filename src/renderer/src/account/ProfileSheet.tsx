import { useEffect, useState } from 'react'
import type { AccountProfile, AccountStatus, AdmittedPhone } from '../../../shared/account-v2'
import type { ApprovalRequest } from '../../../shared/account-approvals'
import type { WorkspaceMeta } from '../../../shared/model'
import { cookrew } from '../api'
import {
  ACCOUNT_COPY,
  deviceName,
  envIgnoredSentence,
  initialsOf,
  profileKey,
  refusalSentence,
  revokeSentence,
} from './account-store'
import { ApprovalCard } from './ApprovalCard'
import { DOING, problemSentence } from './problem'
import { PairPhoneSheet } from './PairPhoneSheet'
import { SecurityCard } from './SecurityCard'
import { SeatsTab } from './SeatsTab'
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
 * WHAT IS NOT HERE, deliberately: nothing in this sheet can approve a device
 * (D6, phase 4) or reach another desktop (phase 3). The tabs for those exist
 * and are honest about being empty. An empty tab that says "No seats yet." is
 * a promise about where the thing will appear; a tab that is missing is a
 * feature the person cannot find later. SEATS & TEAMS is filled in by
 * SeatsTab.tsx (phase 5).
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
  // The key this name held before passwords (phase 6). It is listed like any
  // other device because that is what it now is — and revoking it is how the
  // pre-password world ends on this account.
  legacy: 'KEY',
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
  focusRequestId = null,
  onClose,
  onStatus,
}: {
  status: AccountStatus
  initialTab?: ProfileTab
  /** The request a notification was clicked for; its card is shown first. */
  focusRequestId?: string | null
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
  /** The devices waiting for an answer (D6) — main's polled queue. */
  const [requests, setRequests] = useState<readonly ApprovalRequest[]>([])
  /** The display name while it is being edited; null when it is not. */
  const [editing, setEditing] = useState<string | null>(null)
  /** A failure from the security card's own actions (lock, codes file). */
  const [problem, setProblem] = useState<string | null>(null)
  const username = status.username ?? ''

  // Re-read whenever the count changes, so approving on the card and the
  // badge in the bar cannot disagree about what is still waiting.
  useEffect(() => {
    const call = cookrew().accountApprovals
    if (!call) return
    void call()
      .then(setRequests)
      .catch(() => undefined)
  }, [status.requests])

  useEffect(() => {
    void cookrew()
      .listWorkspaces()
      .then((list) => setWorkspaces(list.workspaces))
      .catch(() => undefined)
  }, [])

  // RE-READ WHEN A REQUEST IS ANSWERED, not only when the sheet is opened.
  // Approving attaches the device at the registry, so the moment the waiting
  // count drops is the moment this list is stale — and a DEVICES tab that
  // only catches up on the next open reads as an approval that did nothing.
  const key = profileKey(status)
  useEffect(() => {
    const call = cookrew().accountProfile
    if (!call) return
    void call()
      .then((result) => {
        if (result.ok) setProfile(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => setError(problemSentence(DOING.PROFILE, err)))
  }, [username, key])

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
    // The row goes when MAIN says it is gone, not when the tap happens. An
    // optimistic removal here is how a failed write reads as a success: the
    // phone vanishes from the list and keeps opening the Mac.
    void call(deviceId)
      .then((forgotten) => {
        if (forgotten) setAdmitted((prior) => prior.filter((p) => p.deviceId !== deviceId))
        else setError('That phone could not be forgotten. Try again.')
      })
      .catch((err: unknown) => setError(problemSentence(DOING.FORGET, err)))
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
      .catch((err: unknown) => setError(problemSentence(DOING.REVOKE, err)))
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
      .catch((err: unknown) => setError(problemSentence(DOING.DISPLAY_NAME, err)))
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
        className="gs-sheet cr-sheet cr-acct-sheet"
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

        {/* THE REQUEST COMES FIRST, above every tab: a person who clicked
            the notification or the rose badge is here for this and nothing
            else, and it must not be behind a tab they have to find. */}
        <ApprovalCard
          requests={requests}
          username={username}
          focusId={focusRequestId}
          onStatus={onStatus}
        />

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
              /* Phase 6: the account decides now, so the row says which name
                 won rather than promising that one day one will. */
              <p className="gs-foot-note">{envIgnoredSentence(status.envUsername, username)}</p>
            )}
          </section>
        )}

        {tab === 'DEVICES' && (
          <section className="cr-acct-pane" aria-label="Devices">
            <button className="gs-revoke cr-acct-act" onClick={() => setPairing(true)}>
              PAIR A PHONE
            </button>
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
            recoveryCodesSavedAt={status.recoveryCodesSavedAt}
            recoveryCodesLeft={profile?.recoveryCodesLeft ?? status.recoveryCodesLeft}
            problem={problem}
            {...securityActions(onStatus, onClose, setProblem)}
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

        {tab === 'SEATS & TEAMS' && <SeatsTab username={username} />}
      </div>
    </div>
  )
}
