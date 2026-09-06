import { useCallback, useEffect, useState } from 'react'
import { AuthError, authStore, REAUTH_COPY, reauthMessage, tokenFromInput } from './auth-gate'
import { checkAuth } from './remote-api'
import './auth-gate.css'

/**
 * The screen an unpaired phone gets instead of a UI that silently does
 * nothing. It appears when the server refuses the credential, and it is the
 * only place a new one can be supplied.
 *
 * Deliberately NOT dismissible into a working-looking app: the app is not
 * working. It can be dismissed into read-only, because read-only is a real,
 * usable state — you just cannot type into an agent.
 */
export function ReauthOverlay(): React.JSX.Element | null {
  const [blocked, setBlocked] = useState<AuthError | null>(() => authStore().blocked())
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const unsubscribe = authStore().subscribe((next) => {
      setBlocked(next)
      if (next) setDismissed(false)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    const token = tokenFromInput(pasted)
    if (!token) {
      setError(REAUTH_COPY.shape)
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Verify BEFORE storing: a token that is saved and then rejected leaves
      // the phone in the same silent-failure state, one screen later.
      const scope = await checkAuth(token)
      if (scope === 'none') {
        setError(REAUTH_COPY.refused)
        return
      }
      authStore().save(token)
      setPasted('')
      if (scope === 'read-only') {
        setError(null)
        authStore().report(new AuthError('Paired read-only.', 'read-only'))
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Could not reach Cookrew: ${cause.message}`
          : 'Could not reach Cookrew.'
      )
    } finally {
      setBusy(false)
    }
  }, [pasted])

  if (!blocked || dismissed) return null
  const readOnly = blocked.scope === 'read-only'

  return (
    <div className="cr-reauth" role="dialog" aria-modal="true" aria-labelledby="cr-reauth-title">
      <div className="cr-reauth-card">
        <h2 id="cr-reauth-title" className="cr-reauth-title">
          {readOnly ? REAUTH_COPY.readOnlyTitle : REAUTH_COPY.title}
        </h2>
        <p className="cr-reauth-body">{reauthMessage(blocked.scope)}</p>
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
      </div>
    </div>
  )
}
