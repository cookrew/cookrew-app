import { useEffect, useState } from 'react'
import { registryMismatchSentence } from '../../../shared/account-v2'
import type { AccountProfile, AccountStatus, AdmittedPhone } from '../../../shared/account-v2'
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
  signOutSentence,
  addDeviceSentence,
  codeExpirySentence,
} from './account-store'
import { QrCode } from './QrCode'
import { qrMatrix } from '../../../shared/qr'
import { RequestsTab } from './RequestsTab'
import { DOING, problemSentence } from './problem'
import { PairPhoneSheet } from './PairPhoneSheet'
import { ResumeSession } from './ResumeSession'
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
  // D11: the one queue, where D6's pinned card used to be. It sits beside
  // DEVICES because that is what most of its rows are about.
  'REQUESTS',
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
  initialProfile = null,
  onClose,
  onStatus,
}: {
  status: AccountStatus
  initialTab?: ProfileTab
  /** The request a notification was clicked for; its card is shown first. */
  focusRequestId?: string | null
  /**
   * The profile to open on, before /v2/me has answered. The surface never
   * passes one; a static render of the Devices tab (which has no effects to
   * fetch with) does, so the rows can be pinned in a test.
   */
  initialProfile?: AccountProfile | null
  onClose: () => void
  onStatus: (next: AccountStatus) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<ProfileTab>(initialTab)
  /** THIS MAC'S workspaces, read from the store the canvas already uses —
   *  names and ids, which is all that ever leaves the desktop (P1). */
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceMeta[]>([])
  const [profile, setProfile] = useState<AccountProfile | null>(initialProfile)
  const [error, setError] = useState<string | null>(null)
  /**
   * The row whose verb was pressed and is waiting for the password: a device
   * id for REVOKE, 'self' for SIGN OUT ON THIS MAC. One at a time — two open
   * confirmations would be two password fields for one act.
   */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The step-up password. Spent the moment the act is done, either way. */
  const [stepUp, setStepUp] = useState('')
  const [acting, setActing] = useState(false)
  /**
   * D12: which machine the owner pressed ADD for, while its password is
   * being typed and after the code exists. One at a time, like the step-up
   * on the rows above: two codes on screen would be two live codes, and the
   * registry keeps one.
   */
  const [adding, setAdding] = useState<'mac' | 'phone' | null>(null)
  const [minted, setMinted] = useState<{ code: string; expiresAt: number; url: string } | null>(
    null,
  )
  const [admitted, setAdmitted] = useState<readonly AdmittedPhone[]>([])
  const [pairing, setPairing] = useState(false)
  /** The display name while it is being edited; null when it is not. */
  const [editing, setEditing] = useState<string | null>(null)
  /** A failure from the security card's own actions (lock, codes file). */
  const [problem, setProblem] = useState<string | null>(null)
  const username = status.username ?? ''

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
    // BACK OFF WHILE THE SESSION IS DEAD. Every read would spend a request to
    // be told the same 401, and each refusal would overwrite the header with a
    // sentence the resume card is already saying better.
    if (!call || status.sessionExpired) return
    void call()
      .then((result) => {
        if (result.ok) setProfile(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => setError(problemSentence(DOING.PROFILE, err)))
  }, [username, key, status.sessionExpired])

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

  /**
   * ADD A MAC / ADD A PHONE (D12) — the code is minted under step-up.
   *
   * The registry asks for the password again on this route and so does this
   * sheet: minting a join code widens what the account can be opened from,
   * which is the definition of a step-up act. The password is spent at once
   * and never kept; the code that comes back is one-shot and ten minutes old
   * at most, which the sentence beside it says.
   */
  const mintCode = (): void => {
    const call = cookrew().accountJoinCode
    if (!call || acting || stepUp.length === 0 || adding === null) return
    setActing(true)
    setError(null)
    void call(stepUp)
      .then((result) => {
        setActing(false)
        setStepUp('')
        if (!result.ok) {
          setError(refusalSentence(result.reason, result.message, username))
          return
        }
        setMinted(result.value)
      })
      .catch((err: unknown) => {
        setActing(false)
        setError(problemSentence(DOING.JOIN_CODE, err))
      })
  }

  /** Close the ADD panel, whichever half of it is on screen. */
  const closeAdd = (): void => {
    setAdding(null)
    setMinted(null)
    setStepUp('')
  }

  /** Both verbs end the same way: the field is emptied, the row closes. */
  const settled = (): void => {
    setActing(false)
    setStepUp('')
    setConfirming(null)
  }

  /**
   * REVOKE, behind the password (D12). The DELETE goes only after cookrew.dev
   * has taken the password again; a refusal is said in the registry's words,
   * with the field still open, so a fat-fingered password is one more try and
   * not a closed row.
   */
  const revoke = (id: string): void => {
    const call = cookrew().accountRevoke
    if (!call || acting || stepUp.length === 0) return
    setActing(true)
    setError(null)
    void call({ deviceId: id, password: stepUp })
      .then((result) => {
        if (!result.ok) {
          setActing(false)
          setError(refusalSentence(result.reason, result.message, username))
          return
        }
        settled()
        setProfile((prior) =>
          prior ? { ...prior, devices: prior.devices.filter((d) => d.id !== id) } : prior,
        )
      })
      .catch((err: unknown) => {
        setActing(false)
        setError(problemSentence(DOING.REVOKE, err))
      })
  }

  /**
   * SIGN OUT ON THIS MAC (D12). On success the status handed back has no
   * username, and the surface that owns this sheet closes it — there is no
   * account left to draw a profile of. The last device is refused with the
   * sentence that says what would be lost; the row stays open on it.
   */
  const signOut = (): void => {
    const call = cookrew().accountSignOut
    if (!call || acting || stepUp.length === 0) return
    setActing(true)
    setError(null)
    void call(stepUp)
      .then((result) => {
        if (!result.ok) {
          setActing(false)
          setError(refusalSentence(result.reason, result.message, username))
          return
        }
        settled()
        onStatus(result.value)
      })
      .catch((err: unknown) => {
        setActing(false)
        setError(problemSentence(DOING.SIGN_OUT, err))
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

        {/* THE APP IS AT THE WRONG REGISTRY. Above the session row, because
            while this is true every refusal underneath it — including "your
            session ended" — is coming from a deployment that has never heard
            of this account, and answering the password prompt cannot help. */}
        {status.registryMismatch && (
          <p className="gs-paste-error" role="alert">
            {registryMismatchSentence(status.registryMismatch)}
          </p>
        )}

        {/* THE SESSION ENDED — the sentence comes WITH the field, in the
            header, so it is on screen whichever tab is open. Every tab's own
            reads are refused underneath it until this is answered. */}
        {status.sessionExpired && <ResumeSession onResumed={onStatus} />}

        {error && !status.sessionExpired && (
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
              /* Phase 6: the account decides now, so the row says which name
                 won rather than promising that one day one will. */
              <p className="gs-foot-note">{envIgnoredSentence(status.envUsername, username)}</p>
            )}
          </section>
        )}

        {tab === 'DEVICES' && (
          <section className="cr-acct-pane" aria-label="Devices">
            {/* RESTORED IN INTEGRATION, and by the lane that took it away.
                V3-12 dropped this button because its own ADD A PHONE reached
                the same popout; V3-10's app half then made ADD A PHONE mint a
                JOIN code — the account ceremony (M4) — which is a different
                thing from the pairing URL that admits a phone at THIS Mac on
                Wi-Fi. Two ceremonies, so two ways in, until the two lanes that
                own them agree on one. */}
            <button className="gs-revoke cr-acct-act" onClick={() => setPairing(true)}>
              PAIR A PHONE
            </button>
            <ul className="cr-acct-devices">
              {(profile?.devices ?? []).map((device) => {
                // THIS MAC has one verb and the others have the other. The
                // confirmation is the same shape for both: the sentence that
                // says everything the act does, the password, and a way to
                // keep things as they are.
                const key = device.current ? 'self' : device.id
                const open = confirming === key
                return (
                  <li key={device.id} className="cr-acct-device">
                    <span className="cr-acct-kind">{KIND_LABEL[device.kind] ?? 'DEVICE'}</span>
                    <span className="cr-acct-seclabel">{deviceName(device.name)}</span>
                    {device.current ? (
                      <>
                        <span className="cr-acct-secstate cr-acct-thismac">THIS MAC</span>
                        <button
                          className="gs-revoke"
                          disabled={acting}
                          onClick={() => {
                            setStepUp('')
                            setConfirming(open ? null : 'self')
                          }}
                        >
                          SIGN OUT ON THIS MAC
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="cr-acct-secstate">
                          LAST SEEN {ago(device.lastSeenAt, now)}
                        </span>
                        <button
                          className="gs-revoke"
                          disabled={acting}
                          onClick={() => {
                            setStepUp('')
                            setConfirming(open ? null : device.id)
                          }}
                        >
                          REVOKE
                        </button>
                      </>
                    )}
                    {open && (
                      <div className="cr-acct-stepup">
                        <p className="gs-consequence">
                          {device.current
                            ? signOutSentence(username)
                            : revokeSentence(deviceName(device.name))}
                        </p>
                        {/* THE PASSWORD, HERE. Both verbs step up (D12): a
                            sheet left open on an unlocked Mac is not enough
                            to sign it out or to take another device's key. */}
                        <div className="cr-acct-row">
                          <input
                            type="password"
                            className="gs-input"
                            aria-label="Password"
                            placeholder="password"
                            autoComplete="current-password"
                            value={stepUp}
                            onChange={(e) => setStepUp(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') device.current ? signOut() : revoke(device.id)
                              if (e.key === 'Escape') settled()
                            }}
                          />
                          <button
                            className="gs-revoke"
                            disabled={acting || stepUp.length === 0}
                            onClick={() => (device.current ? signOut() : revoke(device.id))}
                          >
                            {device.current ? 'SIGN OUT' : 'REVOKE'}
                          </button>
                          <button className="gs-ghost" disabled={acting} onClick={settled}>
                            KEEP
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
              {profile !== null && profile.devices.length === 0 && (
                <li className="gs-dim">No devices listed yet.</li>
              )}
            </ul>
            {/* THE TWO VERBS THAT ADD A MACHINE (D12 · V3-10). Both mint the
                SAME kind of code — one live per account — and differ only in
                what a person does with it: a Mac types the eight characters,
                a phone scans the link. So the ceremony is one panel and the
                sentence is the thing that changes. */}
            <div className="cr-acct-row cr-acct-add">
              <button
                className="gs-ghost"
                disabled={acting}
                onClick={() => {
                  closeAdd()
                  setAdding(adding === 'mac' ? null : 'mac')
                }}
              >
                ADD A MAC
              </button>
              <button
                className="gs-ghost"
                disabled={acting}
                onClick={() => {
                  closeAdd()
                  setAdding(adding === 'phone' ? null : 'phone')
                }}
              >
                ADD A PHONE
              </button>
            </div>
            {adding !== null && (
              <div className="cr-acct-addmac">
                {minted === null ? (
                  <>
                    <p className="gs-consequence">{ACCOUNT_COPY.ADD_STEP_UP}</p>
                    <div className="cr-acct-row">
                      <input
                        type="password"
                        className="gs-input"
                        aria-label="Password"
                        placeholder="password"
                        autoComplete="current-password"
                        value={stepUp}
                        onChange={(e) => setStepUp(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') mintCode()
                          if (e.key === 'Escape') closeAdd()
                        }}
                      />
                      <button
                        className="gs-primary"
                        disabled={acting || stepUp.length === 0}
                        onClick={mintCode}
                      >
                        MAKE A CODE
                      </button>
                      <button className="gs-ghost" disabled={acting} onClick={closeAdd}>
                        CANCEL
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="gs-consequence">{addDeviceSentence(adding)}</p>
                    <p className="cr-acct-joincode">{minted.code}</p>
                    {/* THE QR IS THE LINK, NOT THE CODE. A camera that reads
                        eight characters has nowhere to put them; the link
                        opens cookrew.dev/join, which hands the code to the
                        app through `cookrew://join#…` — the fragment, so the
                        code never reaches the site's server. */}
                    <QrCode rows={qrRows(minted.url)} label={addDeviceSentence(adding)} />
                    <p className="cr-acct-addlink">{minted.url}</p>
                    <p className="gs-hint">{codeExpirySentence(minted.expiresAt)}</p>
                    <div className="cr-acct-row">
                      <button className="gs-ghost" onClick={closeAdd}>
                        DONE
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
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

        {/* D11 — three kinds of row, one card. A person who clicked the
            notification or the rose badge lands HERE: AccountSurface opens the
            sheet on this tab, so the destination is the same whichever led
            them. */}
        {tab === 'REQUESTS' && (
          <RequestsTab
            username={username}
            refreshKey={status.requests}
            focusId={focusRequestId}
            onStatus={onStatus}
          />
        )}

        {tab === 'SECURITY' && (
          <SecurityCard
            username={username}
            lockAfterMs={status.lockAfterMs}
            recoveryCodesSavedAt={status.recoveryCodesSavedAt}
            recoveryCodesLeft={profile?.recoveryCodesLeft ?? status.recoveryCodesLeft}
            sessionExpired={status.sessionExpired}
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

/**
 * The QR's modules as the rows QrCode draws, or none.
 *
 * The encoder is shared (shared/qr.ts) and the picture is the component's;
 * this is the one line between them, kept here rather than widening QrCode's
 * contract — the authenticator sheet feeds it rows main encoded, and two
 * shapes for one prop would be a component with an opinion about who called.
 */
function qrRows(text: string): readonly string[] {
  const modules = qrMatrix(text)
  return modules === null ? [] : modules.map((row) => row.map((on) => (on ? '1' : '0')).join(''))
}
