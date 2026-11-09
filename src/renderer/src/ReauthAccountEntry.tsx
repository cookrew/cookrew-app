import { useCallback, useEffect, useState } from 'react'
import type { GrantOptions, PairOffer } from '../../shared/account-pair'
import { REAUTH_COPY, machineSentence } from './auth-gate'
import { enterWithGrant, grantOptions, proveForGrant, type PairClientDeps, type ProveResult } from './account-pair-client'

/**
 * THE ACCOUNT'S WAY IN, on the Not paired card (owner 2026-11-09).
 *
 * First it tries the pass this browser already holds: within twelve hours of a
 * verification every machine of the account opens with no question at all.
 * Without one it asks cookrew.dev how this account can prove itself and offers
 * that — a passkey first, the account password beside it, or, for an account
 * that has neither, the sentence that sends it to set a password.
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

type Phase =
  | { readonly kind: 'entering' }
  | { readonly kind: 'proving'; readonly options: GrantOptions }
  | { readonly kind: 'said'; readonly sentence: string }

const secondsOf = (ms: number): number => Math.max(1, Math.ceil(ms / 1000))

/** The sentence for a refusal, with what is left if it said. */
export function refusalLine(result: { message: string; triesLeft?: number; retryAfterMs?: number }): string {
  if (result.retryAfterMs !== undefined) return `${result.message.replace(/ Try again in (a minute|\d+ s)\.$/, '')} Try again in ${secondsOf(result.retryAfterMs)} s.`
  if (result.triesLeft !== undefined) return `${result.message} ${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left.`
  return result.message
}

export function ReauthAccountEntry({ offer, deps, handle, onEntered }: ReauthAccountEntryProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'entering' })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const say = useCallback((sentence: string): string => machineSentence(sentence, offer.platform), [offer.platform])

  /** Enter with the held pass; without one, ask how this account proves itself. */
  const enter = useCallback(async (): Promise<void> => {
    if (offer.desktopId === null) return
    const result = await enterWithGrant(deps, offer.desktopId)
    if (result.kind === 'entered') {
      if (!(await onEntered(result.token))) setPhase({ kind: 'said', sentence: say(REAUTH_COPY.enterKept) })
      return
    }
    if (result.kind === 'no-device') return setPhase({ kind: 'said', sentence: say(REAUTH_COPY.enterSignIn) })
    if (result.kind === 'refused' || result.kind === 'failed') setLine(refusalLine(result))
    const options = await grantOptions(deps.registry)
    if (options === null) return setPhase({ kind: 'said', sentence: say(REAUTH_COPY.enterUnreachable) })
    setPhase(options.needsPassword ? { kind: 'said', sentence: say(REAUTH_COPY.enterSetPassword) } : { kind: 'proving', options })
  }, [deps, offer.desktopId, onEntered, say])

  useEffect(() => {
    void enter()
  }, [enter])

  const prove = useCallback(
    async (typed: string | null, options: GrantOptions): Promise<void> => {
      setBusy(true)
      setLine(null)
      try {
        const result: ProveResult = await proveForGrant(deps, typed, options)
        setPassword('')
        if (result.kind === 'granted') return await enter()
        if (result.kind === 'needs-password') return setPhase({ kind: 'said', sentence: say(REAUTH_COPY.enterSetPassword) })
        if (result.kind === 'refused' || result.kind === 'failed') setLine(refusalLine(result))
        // A refusal spends the challenge cookrew.dev issued: ask for a fresh one.
        if (typed === null || result.kind === 'refused') {
          const fresh = await grantOptions(deps.registry)
          if (fresh !== null) setPhase({ kind: 'proving', options: fresh })
        }
      } catch (cause) {
        setPassword('')
        setLine(cause instanceof Error ? `Could not reach cookrew.dev: ${cause.message}` : 'Could not reach cookrew.dev.')
      } finally {
        setBusy(false)
      }
    },
    [deps, enter, say]
  )

  if (phase.kind === 'entering') return <p className="cr-reauth-body">{REAUTH_COPY.enterEntering}</p>
  if (phase.kind === 'said') return <p className="cr-reauth-body">{phase.sentence}</p>
  const { options } = phase
  const passkeyOffered = options.methods.passkey && options.passkey !== null && deps.passkey !== null
  return (
    <form
      className="cr-reauth-enter"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && password.length > 0) void prove(password, options)
      }}
    >
      <p className="cr-reauth-body">{say(REAUTH_COPY.enterLede)}</p>
      {passkeyOffered && (
        <button className="cr-btn primary cr-reauth-passkey" type="button" disabled={busy} onClick={() => void prove(null, options)}>
          {REAUTH_COPY.enterPasskey}
        </button>
      )}
      {options.methods.password && (
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
