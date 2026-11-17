import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hostPlatform, machineCopy } from '../../shared/machine-words'
import { cookrew } from './api'
import { Qr } from './account/PairPhoneSheet'
import { inviteRefusal, timeLeft, type WatchState } from './watch-code'
import type { WaitingPhone } from '../../shared/join-code'
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
      <p className="gs-hint">{left} left · works once · Keep this open: you will be asked to keep the phone.</p>
    </>
  )
}

export interface PhoneKeepViewProps {
  readonly name: string
  /** The joining phone's key in six digits; the phone in the owner's hand shows its own. */
  readonly match: string
  /** "4:59" until no answer becomes a Remove, or null once it has. */
  readonly left: string | null
  readonly busy: boolean
  readonly error: string | null
  readonly onKeep: () => void
  readonly onRemove: () => void
}

/**
 * A PHONE JOINED: KEEP IT? (owner 2026-11-17). Asked here only, of the Mac
 * that showed the code. Keep makes it a trusted phone of every Mac until it is
 * removed in Devices; Remove, or no answer in time, removes it everywhere.
 */
export function PhoneKeepView({ name, match, left, busy, error, onKeep, onRemove }: PhoneKeepViewProps): React.JSX.Element {
  return (
    <>
      <p className="gs-sub">{`A phone joined: ${name}. Keep it?`}</p>
      <p className="cr-acct-joincode">{`${match.slice(0, 3)} ${match.slice(3)}`}</p>
      <p className="gs-hint">Keep it only if your iPhone shows the same number: the name is whatever the phone said.</p>
      <p className="gs-consequence">Kept, it reaches every Mac on your account until you remove it in Devices at cookrew.dev. Not yours? Remove it.</p>
      <p className="gs-hint">{left === null ? 'Time ran out: it was removed everywhere.' : `${left} to answer, or it is removed everywhere.`}</p>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <div className="gs-sheet-foot">
        <button type="button" className="gs-ghost" onClick={onRemove} disabled={busy || left === null}>
          REMOVE
        </button>
        <button type="button" className="gs-primary" onClick={onKeep} disabled={busy || left === null}>
          {busy ? 'ANSWERING…' : 'KEEP'}
        </button>
      </div>
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

/** How often the sheet asks whether a phone has joined with its code. */
const JOIN_POLL_MS = 2000

/** Where the question stands, once a phone has joined. */
type Answered = { readonly phone: WaitingPhone; readonly outcome: 'asking' | 'kept' | 'removed' }

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
  const [answered, setAnswered] = useState<Answered | null>(null)
  const [answering, setAnswering] = useState(false)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const keepLeft = useTimeLeft(answered?.outcome === 'asking' ? answered.phone.until : null)

  // From the moment the sheet opens, watch for a phone waiting on this Mac (one that spent this code, or an
  // earlier one whose sheet was closed): this Mac is the one asked to keep it. One question at a time.
  useEffect(() => {
    if (answered?.outcome === 'asking') return undefined
    let live = true
    const timer = setInterval(() => {
      void api.phonePending?.().then(
        (result) => {
          // Any phone waiting on this Mac is asked about: one from an earlier code, too, if that sheet was closed.
          const phone = result.ok ? result.value[0] : undefined
          if (live && phone) {
            setAnswerError(null)
            setAnswered({ phone, outcome: 'asking' })
          }
        },
        () => undefined
      )
    }, JOIN_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api, answered])

  const answer = (choice: 'keep' | 'remove'): void => {
    if (answered === null || answering) return
    setAnswering(true)
    setAnswerError(null)
    void (api.phoneAnswer?.(answered.phone.deviceId, choice) ?? Promise.reject(new Error('no answer here'))).then(
      (result) => {
        setAnswering(false)
        if (result.ok) setAnswered({ phone: answered.phone, outcome: choice === 'keep' ? 'kept' : 'removed' })
        // Only the registry's "not found" means the phone is gone; anything else (offline, signed out) left it waiting.
        else if (result.reason === 'not_found') setAnswerError('That phone is no longer waiting: it was removed everywhere. Get a new code to add it again.')
        else setAnswerError(inviteRefusal(result.reason ?? 'unknown', undefined, platform))
      },
      () => {
        setAnswering(false)
        setAnswerError(inviteRefusal('unknown', undefined, platform))
      }
    )
  }
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
        ) : answered !== null ? (
          answered.outcome === 'asking' ? (
            <PhoneKeepView
              name={answered.phone.name}
              match={answered.phone.match}
              left={keepLeft}
              busy={answering}
              error={answerError}
              onKeep={() => answer('keep')}
              onRemove={() => answer('remove')}
            />
          ) : (
            <>
              <p className="gs-consequence">
                {answered.outcome === 'kept'
                  ? `${answered.phone.name} is kept: it reaches every Mac on your account until you remove it in Devices.`
                  : `${answered.phone.name} was removed everywhere.`}
              </p>
              <div className="gs-sheet-foot">
                <button type="button" className="gs-primary" onClick={onClose}>
                  DONE
                </button>
              </div>
            </>
          )
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
