import { useState } from 'react'
import type { AccountStatus, SecondFactorStep } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { ACCOUNT_COPY } from './account-store'
import { DOING, problemSentence, refusedSentence } from './problem'
import { ResumeLadder } from './ResumeLadder'
import { ProviderButtons, useProviders } from './ProviderButtons'
import { PROVIDER_COPY, providerRefusal } from './provider-store'
import type { ProviderId } from '../../../shared/oauth'
import '../grant-surface.css'

/**
 * THE SESSION ENDED — the sentence, the field, and now the whole way back.
 *
 * The first bug this closes: the surface said "Your session ended. Type your
 * password once and this carries on." and gave the owner nowhere to type it.
 * The fix was structural — the sentence lives HERE, beside the box, so nothing
 * can print it without also offering the box.
 *
 * THE SECOND BUG, which is why this file has a ladder in it. The owner typed
 * the right password and cookrew.dev answered 401 `second_factor`, because the
 * account has an authenticator enrolled. The card named the wall — "One more
 * step. Prove it is you." — and offered no step. On the only Mac of an account
 * that is not an inconvenience: no relay line, no reach, the door offline, and
 * nothing on screen to press. Naming a wall is not a way through one.
 *
 * So the card has TWO STEPS AND ONE SHAPE. The password step, then — only if
 * cookrew.dev asks for it — the rungs, in the same card, with the sentence
 * still above them. Never the claim sheet, which is what a person reaches for
 * when an app says their credentials failed and offers no other door.
 *
 * IT GOES STRAIGHT TO THE REGISTRY, not through the local unlock verifier. The
 * commonest way to arrive here is a password changed on the web, which leaves
 * that verifier holding the OLD password: checking against it first would
 * refuse the new password before cookrew.dev ever saw it.
 */
export function ResumeSession({
  onResumed,
  passwordless = false,
}: {
  onResumed: (status: AccountStatus) => void
  /** No password exists, so the field is not drawn and the provider is the way back. */
  passwordless?: boolean
}): React.JSX.Element {
  const offers = useProviders()
  const [waiting, setWaiting] = useState<ProviderId | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The ladder cookrew.dev opened, or null while the password is the question.
   *
   * The pending id and the rungs, and NOT the password: main keeps that for
   * the length of the ladder, so this component can be unmounted mid-climb
   * without leaving a secret in a closure.
   */
  const [step, setStep] = useState<{ step: SecondFactorStep; lede: string } | null>(null)

  const resume = (): void => {
    const call = cookrew().accountResume
    if (!call || busy || password.length === 0) return
    setBusy(true)
    setError(null)
    void call(password)
      .then((result) => {
        setBusy(false)
        // The password is dropped either way, and immediately: from here on
        // the ladder is addressed by its pending id, and main is the only
        // party that needs the password again.
        setPassword('')
        if (result.ok) {
          onResumed(result.value)
          return
        }
        if (result.reason === 'second_factor') {
          setStep({
            step: result.step,
            lede: result.message ?? ACCOUNT_COPY.SESSION_SECOND_FACTOR,
          })
          return
        }
        // The reason is kept, not flattened: "wrong password" and "cookrew.dev
        // did not answer" send a person to two different places.
        setError(refusedSentence(DOING.RESUME, result))
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(problemSentence(DOING.RESUME, err))
      })
  }

  /** A ladder that went cold puts the password step back, with the reason. */
  const startOver = (sentence: string): void => {
    setStep(null)
    setError(passwordless ? PROVIDER_COPY.LADDER_OVER : sentence)
  }

  /** The same device goes back through the provider, and the same ladder. */
  const resumeWith = (provider: ProviderId): void => {
    const call = cookrew().accountOAuthStart
    if (!call || busy || waiting !== null) return
    setWaiting(provider)
    setError(null)
    void call(provider)
      .then((result) => {
        if (result.ok) onResumed(result.value)
        else if (result.reason === 'second_factor') {
          setStep({ step: result.step, lede: result.message ?? ACCOUNT_COPY.SESSION_SECOND_FACTOR })
        } else if (result.reason !== 'new_identity') setError(providerRefusal(result.reason, result.message))
      })
      .catch((err: unknown) => setError(problemSentence(DOING.RESUME, err)))
      .finally(() => setWaiting(null))
  }

  return (
    <section className="cr-acct-resume" aria-label="Your session ended">
      <p className="gs-consequence">{passwordless ? PROVIDER_COPY.SESSION_ENDED : ACCOUNT_COPY.SESSION_ENDED}</p>
      {step === null ? (
        <>
          {!passwordless && (
          <div className="cr-acct-row">
            <input
              type="password"
              className="gs-input"
              aria-label="Password"
              placeholder="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && resume()}
            />
            <button className="gs-primary" disabled={busy || password.length === 0} onClick={resume}>
              CARRY ON
            </button>
          </div>
          )}
          <ProviderButtons
            offers={offers}
            waiting={waiting}
            onStart={resumeWith}
            onCancel={() => void cookrew().accountOAuthCancel?.()}
          />
          {error && (
            <p className="gs-paste-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <ResumeLadder
          step={step.step}
          lede={step.lede}
          onSignedIn={onResumed}
          onOver={startOver}
        />
      )}
    </section>
  )
}
