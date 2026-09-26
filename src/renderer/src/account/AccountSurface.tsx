import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { AccountAvatar } from './Avatar'
import { AccountToasts } from './AccountToasts'
import { AccountSheet } from './AccountSheet'
import { FirstRunCard } from './FirstRunCard'
import { firstRunView, type FirstRunAction } from './account-store'
import { JoinCard } from './JoinCard'
import { dismissFirstRun, firstRunDismissed } from './first-run'
import { LockScreen } from './LockScreen'
import { ProfileSheet, type ProfileTab } from './ProfileSheet'
import { ResumeSession } from './ResumeSession'
import { SecurityCard } from './SecurityCard'
import { securityActions } from './security-actions'
import { onAccountSheetRequest, onJoinRequest } from './open-request'

/**
 * THE ACCOUNT SURFACE, assembled — one hook, so App gains three lines.
 *
 * It hands back two nodes: the avatar for the header's brand group, and the
 * overlays. Everything else about identity lives inside this directory, which
 * is the point — the canvas does not need to know that an account exists.
 *
 * FEATURE-DETECTED, NOT MODE-SWITCHED. `accountStatus` is present only on the
 * Electron bridge, so its absence IS the statement "no account surface here":
 * the phone companion and the demo tab render nothing and ask for nothing.
 * Phase 2 gives the phone its own.
 */

/** Activity is a ping, not a stream: at most one per this many ms. */
const ACTIVITY_EVERY_MS = 30_000

export interface AccountSurface {
  /** The header's brand-group avatar, or null when there is no bridge. */
  avatar: React.JSX.Element | null
  /** The sheets and the lock overlay, mounted last so they sit over the canvas. */
  overlays: React.JSX.Element | null
}

export function useAccountSurface(): AccountSurface {
  /**
   * THE OWNER'S SURFACE, feature-detected — and `accountStatus` alone stopped
   * being the marker.
   *
   * Phase 2 gave the companion a READ-ONLY `accountStatus` over HTTP so the
   * phone's own avatar could draw initials. This hook kept treating that as
   * "there is an owner surface here" and mounted a second avatar beside the
   * companion's, in the same brand group — two identical circles, one of
   * which opens sheets whose IPC the phone does not have. `accountClaim` is
   * the honest marker: only main exposes it, and only where a name can be
   * claimed is this whole surface meaningful.
   */
  const supported = typeof cookrew().accountClaim === 'function'
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [sheet, setSheet] = useState<'none' | 'account' | 'profile' | 'security'>('none')
  /** Which tab the account sheet opens on: SIGN IN unless a button chose CREATE. */
  const [initialTab, setInitialTab] = useState<'signin' | 'register'>('signin')
  /**
   * D8: how many workspaces this Mac has, or null until the list has been
   * read. A fresh install has one (seeded); the card waits for the number
   * rather than guessing, so it never flashes at an owner on launch.
   */
  const [workspaceCount, setWorkspaceCount] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(() => firstRunDismissed())
  /**
   * D8: the code a deep link brought, or one typed into the first-run card,
   * waiting for the person to press JOIN. Null the rest of the time — nothing
   * is spent by a card appearing.
   */
  const [joining, setJoining] = useState<string | null>(null)
  const [tab, setTab] = useState<ProfileTab>('PROFILE')
  /** The request a system notification was clicked for (D6). */
  const [focusRequest, setFocusRequest] = useState<string | null>(null)
  /** A failure from the D3 card's own actions, said on the card. */
  const [problem, setProblem] = useState<string | null>(null)

  /** The latest status, for listeners that must not be re-subscribed per change. */
  const statusRef = useRef(status)
  statusRef.current = status

  const refresh = useCallback(() => {
    const call = cookrew().accountStatus
    if (!call) return
    void call()
      .then(setStatus)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!supported) return
    refresh()
    const offLock = cookrew().onAccountLocked?.(() => refresh())
    // THE ACCOUNT CAN CHANGE WITHOUT A CLICK HERE — a password changed on the
    // web ends this session, and nothing local would notice. Main pushes; this
    // re-reads, and the resume field appears on its own.
    const offChanged = cookrew().onAccountChanged?.(() => refresh())
    return () => {
      offLock?.()
      offChanged?.()
    }
  }, [supported, refresh])

  // D8 needs one fact the account does not carry: whether this Mac has a
  // workspace of the person's own. The list is the store's, pushed on change.
  useEffect(() => {
    if (!supported) return
    const count = (list: { workspaces: readonly unknown[] }): void =>
      setWorkspaceCount(list.workspaces.length)
    void cookrew()
      .listWorkspaces()
      .then(count)
      .catch(() => undefined)
    return cookrew().onWorkspaceList(count)
  }, [supported])

  // A DEVICE IS ASKING (D6). The queue changed, or the owner clicked the
  // system notification — in which case main names the request and the sheet
  // opens on it. Never a modal: this is the same destination the rose badge
  // leads to, so both routes land a person on one card.
  useEffect(() => {
    if (!supported) return
    const off = cookrew().onAccountRequests?.((requestId) => {
      refresh()
      if (requestId === null) return
      setFocusRequest(requestId)
      // ON THE QUEUE, not on the profile. A person who clicked the
      // notification is here for one row and nothing else; landing them a tab
      // away from it is the same as not opening anything.
      setTab('REQUESTS')
      setSheet('profile')
    })
    return off
  }, [supported, refresh])

  // PRESENCE, THROTTLED. The lock only needs to know a person is there, not
  // what they did — so a bounded ping beats forwarding every event, and the
  // listener is passive (capture, never preventing) so nothing on the canvas
  // behaves differently because the lock is watching.
  useEffect(() => {
    if (!supported) return
    let last = 0
    const ping = (): void => {
      const now = Date.now()
      if (now - last < ACTIVITY_EVERY_MS) return
      last = now
      void cookrew()
        .accountActivity?.()
        .catch(() => undefined)
    }
    const events: readonly (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'focus']
    for (const event of events)
      window.addEventListener(event, ping, { capture: true, passive: true })
    return () => {
      for (const event of events) window.removeEventListener(event, ping, { capture: true })
    }
  }, [supported])

  // THE ONE WAY IN, shared by the avatar and by anyone who asks (G1: the
  // gate sheet's identify step opens this in place). A signed-in account
  // lands on its profile; no account lands on the claim sheet, which V3-02
  // grows into the three-state sheet — this is its one entry either way.
  const open = useCallback((): void => {
    if (status?.username) {
      setTab('PROFILE')
      setSheet('profile')
    } else {
      setInitialTab('signin')
      setSheet('account')
    }
  }, [status?.username])

  useEffect(() => {
    if (!supported) return
    return onAccountSheetRequest(open)
  }, [supported, open])

  // D8: `cookrew://join#<code>`, routed here by App — the bridge holds one
  // deep-link subscriber and App is it. The card is offered, never acted on:
  // a link that attached this Mac on arrival would be a link anybody could
  // send. A Mac that already has an account ignores it; joining twice is not
  // a thing, and the sheet would be a question with no true answer.
  useEffect(() => {
    if (!supported) return
    return onJoinRequest((code) => {
      if (statusRef.current?.username) return
      setJoining(code)
    })
  }, [supported])

  if (!supported) return { avatar: null, overlays: null }

  /** The first-run card's buttons: two open the sheet on a tab, one closes for good. */
  const firstRun = (action: FirstRunAction): void => {
    if (action === 'dismiss') {
      dismissFirstRun()
      setDismissed(true)
      return
    }
    setInitialTab(action)
    setSheet('account')
  }
  const firstRunCard = firstRunView({ status, workspaceCount, dismissed })

  const overlays = (
    <>
      {/* account:changed, said in the window the owner is already in. It
          answers nothing and steals no click: the queue is where an account
          event is acted on. */}
      <AccountToasts />
      {/* D8: one card, on a fresh Mac only. Drawn under the sheets, and it
          takes nothing over — the avatar keeps the same door forever. */}
      {firstRunCard && joining === null && (
        <FirstRunCard view={firstRunCard} onAction={firstRun} onJoin={setJoining} />
      )}
      {/* D8: the one card that spends a code — typed here or deep-linked.
          It replaces the first-run card rather than sitting over it: they
          are the same question, asked twice. */}
      {joining !== null && status?.username == null && (
        <JoinCard
          code={joining}
          onDismiss={() => setJoining(null)}
          onJoined={(next) => {
            setJoining(null)
            setStatus(next)
            // The card is done with; a Mac that has joined is a Mac with an
            // account, and the first-run card's own rule already hides it.
            dismissFirstRun()
            setDismissed(true)
          }}
        />
      )}
      {sheet === 'account' && (
        <AccountSheet
          initial={initialTab}
          // PHASE 6: a Mac that already serves under a handle is not choosing
          // a door, it is setting a password on the name it has.
          legacy={status?.legacy ?? null}
          onClose={() => setSheet('none')}
          onDone={(next, via) => {
            setStatus(next)
            // D3 is shown ONCE, right after a name is CREATED here. A sign-in
            // on a second Mac joins an account whose security card was shown
            // on the first, so it lands on the canvas and nothing else.
            setSheet(via === 'signin' ? 'none' : 'security')
          }}
        />
      )}
      {sheet === 'security' && status?.username && (
        <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Security">
          <div className="gs-sheet gs-small cr-sheet cr-acct-sheet">
            {/* The card's own rows read /v2/me. If cookrew.dev has thrown this
                session away, the way back is here, above them — never a
                sentence with nowhere to answer it. */}
            {status.sessionExpired && <ResumeSession onResumed={setStatus} />}
            <SecurityCard
              username={status.username}
              lockAfterMs={status.lockAfterMs}
              recoveryCodesSavedAt={status.recoveryCodesSavedAt}
              recoveryCodesLeft={status.recoveryCodesLeft}
              sessionExpired={status.sessionExpired}
              problem={problem}
              {...securityActions(setStatus, () => setSheet('none'), setProblem)}
            />
            <div className="gs-sheet-foot">
              <button className="gs-ghost" onClick={() => setSheet('none')}>
                DONE
              </button>
            </div>
          </div>
        </div>
      )}
      {sheet === 'profile' && status?.username && (
        <ProfileSheet
          status={status}
          initialTab={tab}
          focusRequestId={focusRequest}
          onClose={() => {
            setFocusRequest(null)
            setSheet('none')
          }}
          onStatus={setStatus}
        />
      )}
      {/* LAST, and over everything: a lock drawn under a sheet is not a lock. */}
      {status?.locked && status.username && (
        <LockScreen
          status={status}
          onUnlocked={(waiting) => {
            refresh()
            // D13: the lock said a device was waiting; unlocking lands on it.
            // The same destination the notification and the rose badge lead
            // to — the one queue (D11) — so the person who unlocked to answer
            // is not then asked to find the question.
            if ((waiting ?? 0) > 0) {
              setTab('REQUESTS')
              setSheet('profile')
            }
          }}
        />
      )}
    </>
  )

  return { avatar: <AccountAvatar status={status} onOpen={open} />, overlays }
}
