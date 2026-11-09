import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthError, authStore, REAUTH_COPY, machineSentence, reauthMessage, tokenFromInput, connectCodeFromInput } from './auth-gate'
import { checkAuth } from './remote-api'
import { clientBase } from './api-base'
import { accountDevice } from './account-device'
import { browserPairDeps, pairOffer } from './account-pair-client'
import { ReauthAccountEntry } from './ReauthAccountEntry'
import type { PairOffer } from '../../shared/account-pair'
import './auth-gate.css'

/**
 * The screen an unpaired phone gets instead of a UI that silently does
 * nothing. It appears when the server refuses the credential, and it is the
 * only place a new one can be supplied.
 *
 * Deliberately NOT dismissible into a working-looking app: the app is not
 * working. It can be dismissed into read-only, because read-only is a real,
 * usable state — you just cannot type into an agent.
 *
 * ON A MACHINE OF THE ACCOUNT (owner 2026-11-09) the card leads with the
 * account — a passkey or the account password, checked by the machine — and
 * the token moves under a fold, kept for a machine with no account.
 */

/** The handle a relay prefix names (`/relay/@drej/desktop/<id>`), for the password manager. */
const handleOfBase = (base: string): string | null => /\/relay\/@([^/]+)\/desktop\//.exec(base)?.[1] ?? null

type AccountState =
  | { readonly kind: 'asking' }
  | { readonly kind: 'enter'; readonly offer: PairOffer }
  | { readonly kind: 'sign-in' | 'elsewhere'; readonly offer: PairOffer }
  | { readonly kind: 'token-only'; readonly platform: string | null }

/** What the card can offer here: the account, a pointer to it, or the token alone. */
async function readAccountState(base: string): Promise<AccountState> {
  const offer = await pairOffer(browserPairDeps(base, accountDevice).machine)
  if (offer === null || offer.desktopId === null || !offer.offered) return { kind: 'token-only', platform: offer?.platform ?? null }
  // The account's way in signs with cookrew.dev's device key, which exists
  // only under cookrew.dev: a direct address is another origin.
  if (handleOfBase(base) === null) return { kind: 'elsewhere', offer }
  return (await accountDevice()) === null ? { kind: 'sign-in', offer } : { kind: 'enter', offer }
}

export function ReauthOverlay(): React.JSX.Element | null {
  const [blocked, setBlocked] = useState<AuthError | null>(() => authStore().blocked())
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [account, setAccount] = useState<AccountState>({ kind: 'asking' })
  const base = clientBase()
  const deps = useMemo(() => browserPairDeps(base, accountDevice), [base])

  useEffect(() => {
    const unsubscribe = authStore().subscribe((next) => {
      setBlocked(next)
      if (next) setDismissed(false)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  const unpaired = blocked !== null && blocked.scope !== 'read-only'
  useEffect(() => {
    if (!unpaired) return
    setAccount({ kind: 'asking' })
    let live = true
    void readAccountState(base).then((state) => {
      if (live) setAccount(state)
    })
    return () => {
      live = false
    }
  }, [unpaired, base])

  const platform =
    account.kind === 'asking' ? null : account.kind === 'token-only' ? account.platform : account.offer.platform

  const keep = useCallback(async (token: string, code: string | null): Promise<boolean> => {
    // Verify BEFORE storing: a token that is saved and then rejected leaves
    // the phone in the same silent-failure state, one screen later.
    const scope = await checkAuth(token)
    if (scope === 'none') return false
    authStore().save(token)
    authStore().saveConnectCode(code)
    if (scope === 'read-only') authStore().report(new AuthError('Paired read-only.', 'read-only'))
    return true
  }, [])

  const entered = useCallback((token: string): Promise<boolean> => keep(token, null), [keep])

  const submit = useCallback(async (): Promise<void> => {
    const token = tokenFromInput(pasted)
    if (!token) {
      setError(machineSentence(REAUTH_COPY.shape, platform))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (!(await keep(token, connectCodeFromInput(pasted)))) {
        setError(machineSentence(REAUTH_COPY.refused, platform))
        return
      }
      setPasted('')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Could not reach Cookrew: ${cause.message}`
          : 'Could not reach Cookrew.'
      )
    } finally {
      setBusy(false)
    }
  }, [pasted, keep, platform])

  if (!blocked || dismissed) return null
  const readOnly = blocked.scope === 'read-only'
  const leadsWithAccount = !readOnly && account.kind !== 'asking' && account.kind !== 'token-only'

  const tokenForm = (
    <>
      <label className="cr-reauth-label" htmlFor="cr-reauth-input">
        {REAUTH_COPY.label}
      </label>
      <input
        id="cr-reauth-input"
        className="cr-reauth-input"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder={REAUTH_COPY.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        // A credential in a text field: keep it off the keyboard's
        // learned-words list and out of autofill.
        type="password"
      />
      {error && <p className="cr-reauth-error">{error}</p>}
      <div className="cr-reauth-actions">
        {readOnly && (
          <button className="cr-btn sm" type="button" onClick={() => setDismissed(true)}>
            {REAUTH_COPY.continueReadOnly}
          </button>
        )}
        <button className="cr-btn sm primary" type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? REAUTH_COPY.checking : REAUTH_COPY.pair}
        </button>
      </div>
    </>
  )

  const accountPart = (): React.JSX.Element | null => {
    if (account.kind === 'asking' || account.kind === 'token-only') return null
    if (account.kind === 'enter') {
      return <ReauthAccountEntry offer={account.offer} deps={deps} handle={handleOfBase(base)} onEntered={entered} />
    }
    const sentence = account.kind === 'sign-in' ? REAUTH_COPY.enterSignIn : REAUTH_COPY.enterElsewhere
    return <p className="cr-reauth-body">{machineSentence(sentence, account.offer.platform)}</p>
  }

  return (
    <div className="cr-reauth" role="dialog" aria-modal="true" aria-labelledby="cr-reauth-title">
      <div className="cr-reauth-card">
        <h2 id="cr-reauth-title" className="cr-reauth-title">
          {readOnly ? REAUTH_COPY.readOnlyTitle : REAUTH_COPY.title}
        </h2>
        {leadsWithAccount ? (
          <>
            {accountPart()}
            <details className="cr-reauth-fold">
              <summary>{REAUTH_COPY.enterToken}</summary>
              <p className="cr-reauth-body">{reauthMessage(blocked.scope, platform)}</p>
              {tokenForm}
            </details>
          </>
        ) : (
          <>
            <p className="cr-reauth-body">{reauthMessage(blocked.scope, platform)}</p>
            {tokenForm}
          </>
        )}
      </div>
    </div>
  )
}
