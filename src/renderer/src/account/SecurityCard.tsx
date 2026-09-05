import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_LOCK_AFTER_MS } from '../../../shared/account-v2'
import type { FactorsView } from '../../../shared/account-approvals'
import { cookrew } from '../api'
import { ACCOUNT_COPY, mustChangeBanner, refusalSentence, type FactorRow } from './account-store'
import { FactorRows, Row } from './FactorRows'
import { NewPasswordCard } from './NewPasswordCard'
import { TotpSheet } from './TotpSheet'
import {
  cannotMakePasskey,
  fromCredential,
  hasPlatformAuthenticator,
  toCreationOptions,
} from './webauthn'
import '../grant-surface.css'

/**
 * THE SECURITY CARD (D3) — shown once right after claiming, and again from
 * Profile → Security. Every row is live now.
 *
 * PASSKEY FIRST, by the ruling: it is the recommended factor and it is the
 * one a person already knows how to use. The row is only RECOMMENDED while
 * there is none — a card that keeps recommending something already done stops
 * being read.
 *
 * WHEN THIS ELECTRON CANNOT MAKE A PASSKEY, THE ROW SAYS SO. A desktop build
 * without a platform authenticator refuses `navigator.credentials.create`,
 * and the honest answer is the one the design writes: add it in a browser,
 * where it works, and it lands on the same account. What this must never do
 * is report a factor that does not exist — the whole value of the row is that
 * the owner can trust what it says about their way back in.
 */

/** Nobody dismisses the codes by reflex: the primary waits five seconds. */
const CODES_SETTLE_MS = 5_000
/** What a passkey made here is called, as the Devices tab lists it (D4). */
const THIS_MAC_PASSKEY = 'Touch ID on this Mac'

export function SecurityCard({
  username,
  lockAfterMs,
  onLockAfterMs,
}: {
  username: string
  lockAfterMs: number
  onLockAfterMs: (ms: number) => void
}): React.JSX.Element {
  const [codes, setCodes] = useState<readonly string[] | null>(null)
  const [factors, setFactors] = useState<FactorsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  const [totp, setTotp] = useState(false)
  /** This build refused to make a passkey; the row offers the browser. */
  const [elsewhere, setElsewhere] = useState(false)
  const [busy, setBusy] = useState(false)

  const readFactors = useCallback(() => {
    const call = cookrew().accountFactors
    if (!call) return
    void call()
      .then((result) => {
        if (result.ok) setFactors(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch(() => setError('Something went wrong on this side. Try again.'))
  }, [username])

  useEffect(readFactors, [readFactors])

  // ASK BEFORE OFFERING. This build may have no Touch ID to give (see
  // webauthn.ts), and a row that says so up front beats a row that says it
  // after the owner has cancelled a dialog about a security key.
  useEffect(() => {
    void hasPlatformAuthenticator().then((yes) => {
      if (!yes) setElsewhere(true)
    })
  }, [])

  useEffect(() => {
    if (codes === null) return
    setSettled(false)
    const timer = window.setTimeout(() => setSettled(true), CODES_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [codes])

  const show = (): void => {
    const call = cookrew().accountRecoveryCodes
    if (!call) return
    setError(null)
    void call()
      .then((result) => {
        if (result.ok) setCodes(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        console.error('recovery codes:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  /**
   * Ask the registry for options, ask the browser for a credential, and file
   * what came back — in that order, and only what came back.
   */
  const addPasskey = async (): Promise<void> => {
    const api = cookrew()
    if (!api.accountPasskeyOptions || !api.accountPasskeyAdd || busy) return
    setBusy(true)
    setError(null)
    try {
      const options = await api.accountPasskeyOptions()
      if (!options.ok) {
        setError(refusalSentence(options.reason, options.message, username))
        return
      }
      let credential: PublicKeyCredential | null = null
      try {
        credential = (await navigator.credentials?.create({
          publicKey: toCreationOptions(options.value),
        })) as PublicKeyCredential | null
      } catch (err: unknown) {
        // NOT A FAILURE MESSAGE: the row changes to the sentence that says
        // where this does work (D3), and no passkey is filed.
        if (cannotMakePasskey(err)) {
          setElsewhere(true)
          return
        }
        throw err
      }
      if (credential === null) {
        setElsewhere(true)
        return
      }
      const filed = await api.accountPasskeyAdd({
        name: THIS_MAC_PASSKEY,
        credential: fromCredential(credential),
      })
      if (!filed.ok) setError(refusalSentence(filed.reason, filed.message, username))
      else readFactors()
    } catch {
      setError('This Mac could not make a passkey. Try it in a browser instead.')
      setElsewhere(true)
    } finally {
      setBusy(false)
    }
  }

  const removeFactor = (row: FactorRow): void => {
    const api = cookrew()
    const call = row.factor === 'totp' ? api.accountTotpRemove : undefined
    const promise = call ? call() : api.accountPasskeyRemove?.(row.id)
    if (!promise) return
    setError(null)
    void promise
      .then((result) => {
        if (!result.ok) setError(refusalSentence(result.reason, result.message, username))
        else readFactors()
      })
      .catch(() => setError('Something went wrong on this side. Try again.'))
  }

  if (codes !== null) {
    return (
      <section className="cr-acct-card" aria-label="Recovery codes">
        <h3 className="cr-acct-cardhead">
          Recovery codes <span className="gs-dim">{ACCOUNT_COPY.CODES_EACH}</span>
        </h3>
        {/* Rendered, never logged. A console.log of these is the account. */}
        <ul className="cr-acct-codes">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="gs-sheet-foot">
          <button
            className="gs-ghost"
            onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}
          >
            COPY
          </button>
          <button className="gs-primary" disabled={!settled} onClick={() => setCodes(null)}>
            I SAVED THEM
          </button>
        </div>
      </section>
    )
  }

  const lockOn = lockAfterMs > 0
  const banner = mustChangeBanner(factors)
  return (
    <section className="cr-acct-card" aria-label="Security">
      {banner !== null && <NewPasswordCard username={username} onDone={readFactors} />}
      <h3 className="cr-acct-cardhead">
        @{username} is yours <span className="gs-dim">protect it</span>
      </h3>
      <ul className="cr-acct-secrows">
        <FactorRows
          factors={factors}
          busy={busy}
          elsewhere={elsewhere}
          onAdd={(row) =>
            row.factor === 'totp' ? setTotp(true) : void addPasskey().catch(() => undefined)
          }
          onRemove={removeFactor}
          onOpenBrowser={(url) => void cookrew().openExternal?.(url)}
        />
        <Row
          kind="RESCUE"
          label="Save your recovery codes"
          state="NOT SAVED"
          action={
            <button className="gs-primary" onClick={show}>
              SHOW
            </button>
          }
        />
        <Row
          kind="LOCK"
          label="Lock Cookrew after 15 min idle"
          action={
            <button
              className={`gs-ghost${lockOn ? ' on' : ''}`}
              aria-pressed={lockOn}
              onClick={() => onLockAfterMs(lockOn ? 0 : DEFAULT_LOCK_AFTER_MS)}
            >
              {lockOn ? 'ON' : 'OFF'}
            </button>
          }
        />
      </ul>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <p className="gs-foot-note">{ACCOUNT_COPY.SECURITY_WHY}</p>
      {totp && (
        <TotpSheet
          username={username}
          onClose={() => setTotp(false)}
          onActive={() => {
            setTotp(false)
            readFactors()
          }}
        />
      )}
    </section>
  )
}
