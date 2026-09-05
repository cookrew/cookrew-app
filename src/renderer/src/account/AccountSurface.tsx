import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { AccountAvatar } from './Avatar'
import { ClaimSheet } from './ClaimSheet'
import { LockScreen } from './LockScreen'
import { ProfileSheet, type ProfileTab } from './ProfileSheet'
import { SecurityCard } from './SecurityCard'
import { securityActions } from './security-actions'

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
  const supported = typeof cookrew().accountStatus === 'function'
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [sheet, setSheet] = useState<'none' | 'claim' | 'profile' | 'security'>('none')
  const [tab, setTab] = useState<ProfileTab>('PROFILE')
  /** The request a system notification was clicked for (D6). */
  const [focusRequest, setFocusRequest] = useState<string | null>(null)

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
    const off = cookrew().onAccountLocked?.(() => refresh())
    return off
  }, [supported, refresh])

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

  if (!supported) return { avatar: null, overlays: null }

  const open = (): void => {
    if (status?.username) {
      setTab('PROFILE')
      setSheet('profile')
    } else {
      setSheet('claim')
    }
  }

  const overlays = (
    <>
      {sheet === 'claim' && (
        <ClaimSheet
          onClose={() => setSheet('none')}
          onClaimed={(next) => {
            setStatus(next)
            // D3 is shown ONCE, right after the claim.
            setSheet('security')
          }}
        />
      )}
      {sheet === 'security' && status?.username && (
        <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Security">
          <div className="gs-sheet gs-small cr-acct-sheet">
            <SecurityCard
              username={status.username}
              lockAfterMs={status.lockAfterMs}
              recoveryCodesSavedAt={status.recoveryCodesSavedAt}
              recoveryCodesLeft={status.recoveryCodesLeft}
              {...securityActions(setStatus, () => setSheet('none'))}
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
      {status?.locked && status.username && <LockScreen status={status} onUnlocked={refresh} />}
    </>
  )

  return { avatar: <AccountAvatar status={status} onOpen={open} />, overlays }
}
