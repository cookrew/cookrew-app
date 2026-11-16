import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hostPlatform, machineCopy } from '../../shared/machine-words'
import { cookrew } from './api'
import { Qr } from './account/PairPhoneSheet'
import { inviteRefusal, timeLeft, type WatchState } from './watch-code'
import './grant-surface.css'
// Where a .cr-sheet takes its colours: without it the code is dark on dark.
import './team-fork.css'

/**
 * ⋯ → PHONE APP (owner 2026-11-16): the QR the native Cookrew phone app scans.
 *
 * One code, under the account's step-up: the phone joins the account as a
 * TRUSTED phone and from then on enters every machine of the account on its
 * own, until it is removed in Devices at cookrew.dev. So the sheet says that
 * before it asks for the password, and the code works once, for ten minutes.
 */

type Account = WatchState['account']

export interface PhoneAskViewProps {
  /** Null while the machine has not said yet. */
  readonly account: Account | null
  readonly sealed: boolean
  readonly platform: string | undefined
  readonly password: string
  readonly busy: boolean
  readonly error: string | null
  readonly onPassword: (next: string) => void
  readonly onAsk: () => void
}

export function PhoneAskView({ account, sealed, platform, password, busy, error, onPassword, onAsk }: PhoneAskViewProps): React.JSX.Element {
  // On a plain-HTTP page the password would cross the network before anyone could refuse it.
  const canMint = sealed && account !== null && account !== 'none'
  const needsPassword = canMint && account === 'password'
  const ready = !busy && canMint && (!needsPassword || password.length > 0)
  if (account === null) return <p className="gs-sub">Checking this machine…</p>
  return (
    <>
      {account === 'none' ? (
        <p className="gs-consequence">{machineCopy('Sign in on this Mac first: the phone app joins your account.', platform)}</p>
      ) : !sealed ? (
        <p className="gs-consequence">{inviteRefusal('not_sealed', undefined, platform)}</p>
      ) : (
        <p className="gs-consequence">
          {machineCopy('The phone joins your account and reaches every Mac on it, from anywhere, until you remove it in Devices at cookrew.dev.', platform)}
        </p>
      )}
      {needsPassword && (
        <>
          <label className="gs-label" htmlFor="phone-app-password">
            Password
          </label>
          <input
            id="phone-app-password"
            className={`gs-input${error ? ' gs-bad' : ''}`}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ready) onAsk()
            }}
          />
        </>
      )}
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      {canMint && (
        <div className="gs-sheet-foot">
          <button type="button" className="gs-primary" onClick={onAsk} disabled={!ready}>
            {busy ? 'ASKING…' : 'GET A CODE'}
          </button>
        </div>
      )}
    </>
  )
}

export interface PhoneCodeViewProps {
  readonly code: string
  readonly url: string
  /** "4:59", or null once the code has run out. */
  readonly left: string | null
  readonly onAgain: () => void
}

export function PhoneCodeView({ code, url, left, onAgain }: PhoneCodeViewProps): React.JSX.Element {
  if (left === null) {
    return (
      <>
        <p className="gs-consequence">That code ran out.</p>
        <div className="gs-sheet-foot">
          <button type="button" className="gs-primary" onClick={onAgain}>
            GET A NEW CODE
          </button>
        </div>
      </>
    )
  }
  return (
    <>
      <p className="gs-sub">Scan this with the Cookrew app on your phone.</p>
      <Qr text={url} label="Join code for the phone app" />
      <p className="cr-acct-joincode">{code}</p>
      <p className="gs-hint">{left} left · works once</p>
    </>
  )
}

/** The minutes left on the code, drawn every second; null once it has run out. */
function useTimeLeft(expiresAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  return expiresAt === null ? null : timeLeft(expiresAt, now)
}

type Minted = { readonly code: string; readonly url: string; readonly expiresAt: number }

/** Why not, as the machine said it: put into words when drawn, for the platform known by then. */
type Refused = { readonly reason: string; readonly message?: string }

export function PhoneAppSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const api = cookrew()
  const [state, setState] = useState<WatchState | null>(null)
  const [unread, setUnread] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Refused | null>(null)
  const [minted, setMinted] = useState<Minted | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const left = useTimeLeft(minted?.expiresAt ?? null)
  // On a phone the page has no platform of its own: the machine says what it is.
  const platform = hostPlatform() ?? state?.platform
  const shown = unread ? inviteRefusal('unknown', undefined, platform) : refused && inviteRefusal(refused.reason, refused.message, platform)

  // What the sheet has to ask for: the account kind and whether this line is sealed (the watch's own answer). Asked once.
  useEffect(() => {
    let live = true
    void api.watchState?.().then(
      (next) => {
        if (live) setState(next)
      },
      () => {
        if (live) setUnread(true)
      }
    )
    return () => {
      live = false
    }
  }, [api])

  // The password field that held focus is gone once the code shows: Escape must still close the sheet.
  useEffect(() => {
    if (minted !== null) closeRef.current?.focus()
  }, [minted])

  const ask = (): void => {
    if (busy) return
    setBusy(true)
    setRefused(null)
    void (api.phoneInvite?.(password) ?? Promise.reject(new Error('no invite here'))).then(
      (result) => {
        setBusy(false)
        setPassword('')
        if (result.ok) setMinted({ code: result.code, url: result.url, expiresAt: result.expiresAt })
        else setRefused({ reason: result.reason, ...(result.message ? { message: result.message } : {}) })
      },
      () => {
        setBusy(false)
        setRefused({ reason: 'unknown' })
      }
    )
  }

  return createPortal(
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Phone app">
      <div
        className="gs-sheet gs-small cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Phone app</h2>
          <button ref={closeRef} type="button" className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {unread ? (
          // The machine never said what it is: nothing to mint from, and it says so.
          <p className="gs-paste-error" role="alert">
            {shown}
          </p>
        ) : minted === null ? (
          <PhoneAskView
            account={state?.account ?? null}
            sealed={state?.sealed ?? false}
            platform={platform}
            password={password}
            busy={busy}
            error={shown}
            onPassword={setPassword}
            onAsk={ask}
          />
        ) : (
          <PhoneCodeView code={minted.code} url={minted.url} left={left} onAgain={() => setMinted(null)} />
        )}
      </div>
    </div>,
    document.body
  )
}
