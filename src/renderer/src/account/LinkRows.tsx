import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { PROVIDER_LABEL, type LinkedProvider, type ProviderId, type ProviderOffer, type VerifiedEmail } from '../../../shared/oauth'
import { cookrew } from '../api'
import { Row } from './FactorRows'
import { useProviders, useTripGuard } from './ProviderButtons'
import { PROVIDER_COPY, passcodeView, providerRefusal } from './provider-store'

/**
 * A link or an unlink, waiting for what must be typed: the password, or a rescue
 * code when a passwordless owner has lost the provider that would prove it.
 */
type Asking = { provider: ProviderId; verb: 'link' | 'unlink'; rescue?: boolean }

/**
 * THE SECURITY CARD'S NEW ROWS: providers, the verified email, the passcode.
 *
 * Linking is where two identities become one account, and this is the only
 * place that happens: a signed-in owner, on purpose, under step-up. There is no
 * field to type an email into, because the only address kept is one a provider
 * has verified.
 */
export function LinkRows({
  offers,
  links,
  email,
  status,
  onStatus,
  onChanged,
}: {
  offers: readonly ProviderOffer[]
  links: readonly LinkedProvider[]
  email: VerifiedEmail | null
  status: AccountStatus
  onStatus: (next: AccountStatus) => void
  onChanged: () => void
}): React.JSX.Element {
  const [asking, setAsking] = useState<Asking | null>(null)
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [passcode, setPasscode] = useState<{ current: string; next: string; confirm: string } | null>(null)
  /** A browser trip is in flight, so the way out has to be on screen. */
  const [tripping, setTripping] = useState(false)
  const trip = useTripGuard()

  const run = (target: Asking, typed: string): void => {
    const api = cookrew()
    const call = target.verb === 'link' ? api.accountOAuthLink : api.accountOAuthUnlink
    if (!call || busy) return
    setBusy(true)
    setTripping(true)
    setError(null)
    trip.begin()
    const proof = typed === '' ? {} : target.rescue === true ? { rescue: typed } : { current: typed }
    void call({ provider: target.provider, ...proof })
      .then((result) => {
        setCurrent('')
        if (result.ok) {
          setAsking(null)
          onChanged()
        } else {
          setError(providerRefusal(result.reason, result.message))
        }
      })
      .catch(() => setError('That did not go through. Try again.'))
      .finally(() => {
        trip.end()
        setTripping(false)
        setBusy(false)
      })
  }

  /** No password to ask for means straight to the provider. */
  const press = (target: Asking): void => {
    if (status.passwordless) run(target, '')
    else {
      setError(null)
      setCurrent('')
      setAsking(target)
    }
  }

  const savePasscode = (): void => {
    const call = cookrew().accountSetPasscode
    if (!call || passcode === null || busy || !passcodeView(passcode.next, passcode.confirm).canGo) return
    setBusy(true)
    setError(null)
    void call({ next: passcode.next, current: passcode.current })
      .then((result) => {
        if (result.ok) {
          setPasscode(null)
          onStatus(result.value)
        } else {
          setError(providerRefusal(result.reason, result.message))
        }
      })
      .catch(() => setError('That could not be saved on this Mac. Try again.'))
      .finally(() => setBusy(false))
  }

  const toggleTouchId = (): void => {
    const call = cookrew().accountSetTouchId
    if (!call || busy) return
    setBusy(true)
    setError(null)
    void call(!status.touchId.on)
      .then((result) => {
        if (result.ok) onStatus(result.value)
        else {
          const sentence = providerRefusal(result.reason, result.message)
          if (sentence !== null) setError(sentence)
        }
      })
      .catch(() => setError('Touch ID did not answer. Try again.'))
      .finally(() => setBusy(false))
  }

  const offered = offers.filter((offer) => !links.some((link) => link.provider === offer.id))
  return (
    <>
      {links.map((link) => (
        <Row
          key={link.provider}
          kind="SIGN-IN"
          label={`${PROVIDER_LABEL[link.provider]}${link.login === null ? '' : ` · ${link.login}`}`}
          {...(link.paused ? { state: 'PAUSED' } : {})}
          action={
            link.paused ? (
              <button className="gs-primary" disabled={busy} onClick={() => press({ provider: link.provider, verb: 'link' })}>
                LINK AGAIN
              </button>
            ) : (
              <button className="gs-ghost" disabled={busy} onClick={() => press({ provider: link.provider, verb: 'unlink' })}>
                REMOVE
              </button>
            )
          }
        />
      ))}
      {offered.map((offer) => (
        <Row
          key={offer.id}
          kind="SIGN-IN"
          label={`Sign in with ${offer.label}`}
          action={
            <button className="gs-ghost" disabled={busy} onClick={() => press({ provider: offer.id, verb: 'link' })}>
              LINK
            </button>
          }
        />
      ))}
      {status.passwordless && offered.length > 0 && asking === null && (
        <Row
          kind="RESCUE"
          label={PROVIDER_COPY.LOST_PROVIDER}
          action={
            <button
              className="gs-ghost"
              disabled={busy}
              onClick={() => setAsking({ provider: offered[0].id, verb: 'link', rescue: true })}
            >
              USE A CODE
            </button>
          }
        />
      )}
      {asking !== null && (
        <li className="cr-acct-secrow cr-acct-removefactor">
          <label className="gs-label" htmlFor="cr-acct-linkpass">
            {asking.rescue === true
              ? `${PROVIDER_COPY.LOST_PROVIDER_WHY} Linking ${PROVIDER_LABEL[asking.provider]}.`
              : `Type your password to ${asking.verb} ${PROVIDER_LABEL[asking.provider]}.`}
          </label>
          <input
            id="cr-acct-linkpass"
            type={asking.rescue === true ? 'text' : 'password'}
            className="gs-input"
            autoComplete={asking.rescue === true ? 'off' : 'current-password'}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && current !== '' && run(asking, current)}
          />
          <button className="gs-primary" disabled={busy || current === ''} onClick={() => run(asking, current)}>
            CONTINUE
          </button>
          <button
            className="gs-ghost"
            onClick={() => {
              trip.leave()
              setAsking(null)
            }}
          >
            CANCEL
          </button>
        </li>
      )}
      {tripping && asking === null && (
        <li className="cr-acct-secrow" role="status">
          <p className="gs-hint">{PROVIDER_COPY.WAITING}</p>
          <button className="gs-ghost" onClick={() => trip.leave()}>
            CANCEL
          </button>
        </li>
      )}
      {email !== null && (
        <Row kind="EMAIL" label={email.address} state={`Verified by ${PROVIDER_LABEL[email.via]}`} saved action={null} />
      )}
      {status.passcodePending && passcode === null && (
        <Row
          kind="LOCK"
          label="Choose a passcode for this Mac"
          action={
            <button className="gs-ghost" onClick={() => setPasscode({ current: '', next: '', confirm: '' })}>
              CHOOSE
            </button>
          }
        />
      )}
      {status.unlockBy === 'passcode' && !status.passcodePending && (
        <Row
          kind="LOCK"
          label="This Mac unlocks with a passcode"
          action={
            <button className="gs-ghost" onClick={() => setPasscode({ current: '', next: '', confirm: '' })}>
              CHANGE
            </button>
          }
        />
      )}
      {passcode !== null && (
        <li className="cr-acct-secrow cr-acct-removefactor">
          {(status.passcodePending ? (['next', 'confirm'] as const) : (['current', 'next', 'confirm'] as const)).map((field) => (
            <input
              key={field}
              type="password"
              className="gs-input"
              aria-label={field === 'current' ? 'Current passcode' : field === 'next' ? 'New passcode' : 'New passcode again'}
              placeholder={field === 'current' ? 'current passcode' : field === 'next' ? 'new passcode' : 'new passcode again'}
              autoComplete={field === 'current' ? 'current-password' : 'new-password'}
              value={passcode[field]}
              onChange={(e) => setPasscode({ ...passcode, [field]: e.target.value })}
            />
          ))}
          <button
            className="gs-primary"
            disabled={busy || !passcodeView(passcode.next, passcode.confirm).canGo}
            onClick={savePasscode}
          >
            SAVE
          </button>
          <button className="gs-ghost" onClick={() => setPasscode(null)}>
            CANCEL
          </button>
        </li>
      )}
      {status.touchId.available && (
        <Row
          kind="LOCK"
          label="Unlock with Touch ID"
          action={
            <button className="gs-ghost" disabled={busy} onClick={toggleTouchId}>
              {status.touchId.on ? 'TURN OFF' : 'TURN ON'}
            </button>
          }
        />
      )}
      {error && (
        <li className="cr-acct-secrow">
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        </li>
      )}
    </>
  )
}

/** The rows with their data: what is offered, and what /v2/me says is linked. */
export function LinkedAccountRows({
  status,
  onStatus,
}: {
  status: AccountStatus
  onStatus: (next: AccountStatus) => void
}): React.JSX.Element {
  const offers = useProviders()
  const [links, setLinks] = useState<readonly LinkedProvider[]>([])
  const [email, setEmail] = useState<VerifiedEmail | null>(null)

  const read = useCallback(() => {
    if (status.sessionExpired) return
    void cookrew()
      .accountProfile?.()
      .then((result) => {
        if (!result.ok) return
        setLinks(result.value.links ?? [])
        setEmail(result.value.email ?? null)
      })
      .catch(() => undefined)
  }, [status.sessionExpired])

  useEffect(read, [read])
  return <LinkRows offers={offers} links={links} email={email} status={status} onStatus={onStatus} onChanged={read} />
}

