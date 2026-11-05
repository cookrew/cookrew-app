import { useEffect, useState } from 'react'
import type { AccountStatus, UsernameCheck } from '../../../shared/account-v2'
import { normaliseUsername, usernameProblem } from '../../../shared/account-v2'
import { PROVIDER_LABEL, type ProviderId } from '../../../shared/oauth'
import { cookrew } from '../api'
import { PROVIDER_COPY, handleView, providerRefusal } from './provider-store'

/** The same wait the create tab keeps between keystrokes and a HEAD. */
const DEBOUNCE_MS = 350

export interface HandleAsked {
  provider: ProviderId
  suggest: string
  free: boolean
  email: string | null
}

/**
 * THE HANDLE IS COOKREW'S OWN.
 *
 * A provider's name only prefills this field. A clash asks, here, with the name
 * kept; nothing is created until a person presses. And the card says how to
 * reach an account they already have, because an unlinked identity is never
 * merged into one on its own.
 */
export function HandleCard({
  asked,
  onDone,
  onBack,
}: {
  asked: HandleAsked
  onDone: (status: AccountStatus) => void
  onBack: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(asked.suggest)
  const [check, setCheck] = useState<UsernameCheck | 'checking'>(asked.free ? 'free' : asked.suggest === '' ? 'invalid' : 'taken')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = normaliseUsername(value)

  useEffect(() => {
    if (name === asked.suggest) {
      setCheck(asked.free ? 'free' : asked.suggest === '' ? 'invalid' : 'taken')
      return
    }
    if (usernameProblem(name) !== 'ok') {
      setCheck('invalid')
      return
    }
    setCheck('checking')
    let live = true
    const timer = window.setTimeout(() => {
      void cookrew()
        .accountCheck?.(name)
        .then((answer) => {
          if (live) setCheck(answer)
        })
        .catch(() => {
          if (live) setCheck('unknown')
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [name, asked.suggest, asked.free])

  const view = handleView(name, check)

  const claim = (): void => {
    const call = cookrew().accountOAuthClaim
    if (!call || busy || !view.canGo) return
    setBusy(true)
    setError(null)
    void call(name)
      .then((result) => {
        if (result.ok) {
          onDone(result.value)
          return
        }
        if (result.reason === 'taken') setCheck('taken')
        else setError(providerRefusal(result.reason, result.message))
      })
      .catch(() => setError('That did not go through. Try again.'))
      .finally(() => setBusy(false))
  }

  return (
    <section className="cr-acct-handle" aria-label={PROVIDER_COPY.HANDLE_TITLE}>
      <h3 className="cr-acct-cardhead">{PROVIDER_COPY.HANDLE_TITLE}</h3>
      <p className="gs-hint">
        Signed in with {PROVIDER_LABEL[asked.provider]}
        {asked.email === null ? '.' : ` as ${asked.email}.`} {PROVIDER_COPY.HANDLE_WHY}
      </p>
      <label className="gs-label" htmlFor="cr-acct-handle">
        Username
      </label>
      <input
        id="cr-acct-handle"
        className={`gs-input${view.tone === 'bad' ? ' gs-bad' : ''}`}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && claim()}
      />
      <p className={`gs-hint cr-acct-${view.tone}`}>{view.note}</p>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <div className="gs-sheet-foot">
        <button className="gs-ghost" disabled={busy} onClick={onBack}>
          BACK
        </button>
        <button className="gs-primary" disabled={busy || !view.canGo} onClick={claim}>
          CREATE ACCOUNT
        </button>
      </div>
      <p className="gs-foot-note">{PROVIDER_COPY.ALREADY_HAVE}</p>
    </section>
  )
}
