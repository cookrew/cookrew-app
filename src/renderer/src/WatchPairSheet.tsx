import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { hostPlatform, machineCopy } from '../../shared/machine-words'
import { cookrew } from './api'
import { inviteRefusal, spacedCode, timeLeft, typedAddress, watchClaimed, type WatchCode, type WatchState } from './watch-code'
import './grant-surface.css'
// Where a .cr-sheet takes its colours: without it the code is dark on dark.
import './team-fork.css'

/** How often the sheet asks whether the watch has arrived. */
const CLAIM_POLL_MS = 1500

type Stage =
  | { name: 'ask' }
  | { name: 'code'; code: string; expiresAt: number; seen: number }
  | { name: 'digits'; code: WatchCode }
  | { name: 'done' }

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

/** Waits for the watch: the sheet says so the moment the Mac has been claimed. */
function useClaimed(expiresAt: number | null, seen: number, onClaimed: () => void): void {
  const api = cookrew()
  useEffect(() => {
    if (expiresAt === null) return undefined
    const timer = setInterval(() => {
      void api.watchState?.().then(
        (state) => {
          if (watchClaimed(state, seen, expiresAt, Date.now())) onClaimed()
        },
        () => undefined
      )
    }, CLAIM_POLL_MS)
    return () => clearInterval(timer)
  }, [api, expiresAt, seen, onClaimed])
}

function AskPane({
  account,
  sealed,
  platform,
  onCode,
  onDigits
}: {
  account: WatchState['account'] | null
  sealed: boolean
  /** The machine's platform: the desktop's own, or what a phone was told. */
  platform: string | undefined
  onCode: (code: string, expiresAt: number, seen: number) => void
  onDigits: (code: WatchCode) => void
}): React.JSX.Element {
  const api = cookrew()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // On a plain-HTTP page the password would cross the network before anyone
  // could refuse it, so there is no field to type it in.
  const canMint = sealed && account !== null && account !== 'none'
  const needsPassword = canMint && account === 'password'
  const ready = !busy && canMint && (!needsPassword || password.length > 0)

  const ask = (): void => {
    if (!ready) return
    setBusy(true)
    setError(null)
    void (api.watchInvite?.(password) ?? Promise.reject(new Error('no invite here'))).then(
      (result) => {
        setBusy(false)
        setPassword('')
        if (result.ok) onCode(result.code, result.expiresAt, result.claims)
        else setError(inviteRefusal(result.reason, result.message, platform))
      },
      () => {
        setBusy(false)
        setError(inviteRefusal('unknown', undefined, platform))
      }
    )
  }
  const digits = (): void => {
    setError(null)
    api.watchCode?.().then(onDigits, () => setError(inviteRefusal('unknown', undefined, platform)))
  }

  return (
    <>
      {account === 'none' ? (
        <p className="gs-consequence">{machineCopy('A watch reaches this Mac from anywhere through your account.', platform)} Without one, it only works on this network.</p>
      ) : !sealed ? (
        <p className="gs-consequence">{inviteRefusal('not_sealed', undefined, platform)}</p>
      ) : (
        <p className="gs-consequence">
          It joins your account and works your agents from anywhere: it reads and answers them, starts new ones in any workspace, and taps and types in
          their browser pages.
        </p>
      )}
      {needsPassword && (
        <>
          <label className="gs-label" htmlFor="watch-pair-password">
            Password
          </label>
          <input
            id="watch-pair-password"
            className={`gs-input${error ? ' gs-bad' : ''}`}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') ask()
            }}
          />
        </>
      )}
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <div className="gs-sheet-foot">
        <button type="button" className="gs-ghost" onClick={digits} disabled={busy}>
          USE SIX DIGITS
        </button>
        {canMint && (
          <button type="button" className="gs-primary" onClick={ask} disabled={!ready}>
            {busy ? 'ASKING…' : 'GET A CODE'}
          </button>
        )}
      </div>
    </>
  )
}

function CodePane({
  code,
  expiresAt,
  seen,
  onDone,
  onAgain
}: {
  code: string
  expiresAt: number
  seen: number
  onDone: () => void
  onAgain: () => void
}): React.JSX.Element {
  const left = useTimeLeft(expiresAt)
  useClaimed(left === null ? null : expiresAt, seen, onDone)
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
      <p className="gs-sub">Type this on the watch.</p>
      <p className="cr-acct-joincode">{code}</p>
      <p className="gs-hint">{left} left · works once · waiting for the watch…</p>
    </>
  )
}

function DigitsPane({
  code,
  seen,
  onDone,
  onAgain
}: {
  code: WatchCode
  seen: number
  onDone: () => void
  onAgain: () => void
}): React.JSX.Element {
  const left = useTimeLeft(code.expiresAt)
  useClaimed(left === null ? null : code.expiresAt, seen, onDone)
  if (left === null) {
    return (
      <div className="gs-sheet-foot">
        <button type="button" className="gs-primary" onClick={onAgain}>
          START AGAIN
        </button>
      </div>
    )
  }
  return (
    <>
      <p className="gs-sub">Only on this network. Type the address, then the digits, on the watch.</p>
      <p className="cr-acct-joincode">{spacedCode(code.code)}</p>
      <p className="gs-hint">
        {typedAddress(code.bases) ?? 'no address'} · {left} left
      </p>
    </>
  )
}

/**
 * PAIR AN APPLE WATCH — one code, anywhere. The account's join code lets the
 * watch into the account and, armed on this Mac, claims the Mac too, so the watch
 * needs no address and can do it from anywhere. Six digits stay for a Mac with no
 * account, on its own network.
 */
export function WatchPairSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const api = cookrew()
  const [stage, setStage] = useState<Stage>({ name: 'ask' })
  const [opened, setOpened] = useState<WatchState | null>(null)
  const [unread, setUnread] = useState(false)

  useEffect(() => {
    let live = true
    void api.watchState?.().then(
      (state) => {
        if (live) setOpened(state)
      },
      () => {
        if (live) setUnread(true)
      }
    )
    return () => {
      live = false
    }
  }, [api])

  // Stable: the poll that calls it must outlive the countdown's redraws.
  const done = useCallback((): void => setStage({ name: 'done' }), [])
  // On a phone the page has no platform of its own: the machine says what it is.
  const platform = hostPlatform() ?? opened?.platform
  const again = (): void => setStage({ name: 'ask' })

  return createPortal(
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Pair an Apple Watch">
      <div
        className="gs-sheet gs-small cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>{stage.name === 'done' ? 'Apple Watch paired' : 'Pair an Apple Watch'}</h2>
          <button type="button" className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {unread && <p className="gs-paste-error">{inviteRefusal('unknown', undefined, platform)}</p>}
        {stage.name === 'ask' && (
          <AskPane
            account={opened?.account ?? null}
            sealed={opened?.sealed ?? false}
            platform={platform}
            onCode={(code, expiresAt, seen) => setStage({ name: 'code', code, expiresAt, seen })}
            onDigits={(code) => setStage({ name: 'digits', code })}
          />
        )}
        {stage.name === 'code' && <CodePane code={stage.code} expiresAt={stage.expiresAt} seen={stage.seen} onDone={done} onAgain={again} />}
        {stage.name === 'digits' && <DigitsPane code={stage.code} seen={stage.code.claims} onDone={done} onAgain={again} />}
        {stage.name === 'done' && (
          <>
            <p className="gs-consequence">{machineCopy('You can forget it from ⋯ on this Mac or on the watch.', platform)}</p>
            <div className="gs-sheet-foot">
              <button type="button" className="gs-primary" onClick={onClose}>
                DONE
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
