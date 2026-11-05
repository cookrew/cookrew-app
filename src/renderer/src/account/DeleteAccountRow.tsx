import { useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import {
  DELETE_ACCOUNT_KEEPS,
  DELETE_ACCOUNT_TAKES,
  DELETE_ACCOUNT_WARNING,
} from '../../../shared/account-delete'
import { cookrew } from '../api'
import { refusalSentence } from './account-store'
import { DOING, problemSentence } from './problem'
import { TripWait, useWatchedTrip } from './ProviderButtons'

/**
 * DELETE ACCOUNT, at the foot of the PROFILE tab.
 *
 * Closed it is one button, so nobody meets the consequences by accident. Open
 * it says what goes and what stays, and the act needs the username typed and the
 * proof: the password, or on an account with none a trip to its provider, which
 * is why this watches the trip like any surface that can open a browser.
 */
export function DeleteAccountRow({
  username,
  passwordless,
  onStatus,
  initialOpen = false,
}: {
  username: string
  passwordless: boolean
  onStatus: (next: AccountStatus) => void
  /** A static render has no click to open it with. */
  initialOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { waiting, watch, cancel } = useWatchedTrip(passwordless)

  if (!open) {
    return (
      <button className="gs-revoke cr-acct-delete-open" onClick={() => setOpen(true)}>
        DELETE ACCOUNT
      </button>
    )
  }

  const close = (): void => {
    setOpen(false)
    setTyped('')
    setPassword('')
    setError(null)
  }
  const ready = typed === username && (passwordless || password.length > 0) && !acting

  const remove = (): void => {
    const call = cookrew().accountDelete
    if (!call || !ready) return
    setActing(true)
    setError(null)
    void watch(call({ confirm: typed, password }))
      .then((result) => {
        setActing(false)
        setPassword('')
        if (result.ok) onStatus(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        setActing(false)
        setError(problemSentence(DOING.DELETE_ACCOUNT, err))
      })
  }

  return (
    <section className="cr-acct-delete" aria-label="Delete account">
      <p className="gs-consequence">{DELETE_ACCOUNT_WARNING}</p>
      <h3>THIS DELETES</h3>
      <ul>
        {DELETE_ACCOUNT_TAKES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3>THIS STAYS</h3>
      <ul>
        {DELETE_ACCOUNT_KEEPS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <input
        className="gs-input"
        aria-label={`Type ${username} to confirm`}
        placeholder={`Type ${username} to confirm`}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      {!passwordless && (
        <input
          className="gs-input"
          type="password"
          aria-label="Your password"
          placeholder="Your password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      )}
      <TripWait shown={waiting} onCancel={cancel} />
      <div className="cr-acct-row">
        <button className="gs-revoke" disabled={!ready} onClick={remove}>
          DELETE MY ACCOUNT
        </button>
        <button className="gs-ghost" disabled={acting} onClick={close}>
          CANCEL
        </button>
      </div>
    </section>
  )
}
