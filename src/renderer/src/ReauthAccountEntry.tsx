import { useCallback, useState } from 'react'
import type { PairOffer } from '../../shared/account-pair'
import { REAUTH_COPY, machineSentence } from './auth-gate'
import type { PairClientDeps } from './account-pair-client'
import { enterWithAccount, type EnterResult } from './account-pair-client'

/**
 * THE ACCOUNT'S WAY IN, on the Not paired card (owner 2026-11-09).
 *
 * A passkey first where the browser has one, the account password beside it.
 * The machine checks either itself (main/account-pair.ts) and hands back a
 * token of this browser's own; the card stores it and gets out of the way.
 *
 * The password lives in this component's state for as long as it is typed and
 * is cleared on every answer, right or wrong.
 */

export interface ReauthAccountEntryProps {
  readonly offer: PairOffer
  readonly deps: PairClientDeps
  /** The handle the relay prefix names, for the password manager's username. */
  readonly handle: string | null
  /** Keeps the token; false when this machine then refuses it. */
  readonly onEntered: (token: string) => Promise<boolean>
}

const secondsOf = (ms: number): number => Math.max(1, Math.ceil(ms / 1000))

/** The sentence for a refusal the machine gave, with what is left if it said. */
export function refusalLine(result: Extract<EnterResult, { kind: 'refused' }>): string {
  if (result.retryAfterMs !== undefined) return `${result.message.replace(/ Try again in \d+ s\.$/, '')} Try again in ${secondsOf(result.retryAfterMs)} s.`
  if (result.triesLeft !== undefined) return `${result.message} ${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left.`
  return result.message
}

export function ReauthAccountEntry({ offer, deps, handle, onEntered }: ReauthAccountEntryProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const say = (sentence: string): string => machineSentence(sentence, offer.platform)
  const passkeyOffered = offer.methods.includes('passkey') && deps.passkey !== null
  const passwordOffered = offer.methods.includes('password')

  const run = useCallback(
    async (typed: string | null): Promise<void> => {
      setBusy(true)
      setLine(null)
      try {
        const result = await enterWithAccount(deps, typed, offer.desktopId)
        setPassword('')
        if (result.kind === 'entered') {
          if (!(await onEntered(result.token))) setLine(machineSentence(REAUTH_COPY.enterKept, offer.platform))
          return
        }
        if (result.kind === 'no-device') setLine(machineSentence(REAUTH_COPY.enterSignIn, offer.platform))
        else if (result.kind === 'refused') setLine(refusalLine(result))
        else if (result.kind === 'failed') setLine(result.message)
      } catch (cause) {
        setPassword('')
        setLine(cause instanceof Error ? `Could not reach this machine: ${cause.message}` : 'Could not reach this machine.')
      } finally {
        setBusy(false)
      }
    },
    [deps, onEntered, offer.platform]
  )

  return (
    <form
      className="cr-reauth-enter"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && password.length > 0) void run(password)
      }}
    >
      <p className="cr-reauth-body">{say(REAUTH_COPY.enterLede)}</p>
      {passkeyOffered && (
        <button className="cr-btn primary cr-reauth-passkey" type="button" disabled={busy} onClick={() => void run(null)}>
          {REAUTH_COPY.enterPasskey}
        </button>
      )}
      {passwordOffered && (
        <>
          {handle && <input type="text" name="username" autoComplete="username" value={handle} readOnly hidden />}
          <label className="cr-reauth-label" htmlFor="cr-reauth-password">
            {REAUTH_COPY.enterPassword}
          </label>
          <div className="cr-reauth-row">
            <input
              id="cr-reauth-password"
              className="cr-reauth-input"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="cr-btn sm primary" type="submit" disabled={busy || password.length === 0}>
              {busy ? REAUTH_COPY.checking : REAUTH_COPY.enterGo}
            </button>
          </div>
        </>
      )}
      {line && (
        <p className="cr-reauth-error" role="status">
          {line}
        </p>
      )}
    </form>
  )
}
