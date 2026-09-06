import { useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { ACCOUNT_COPY } from './account-store'
import { DOING, problemSentence, refusedSentence } from './problem'
import '../grant-surface.css'

/**
 * THE SESSION ENDED — the sentence and the field, together, always.
 *
 * The live bug this closes: the surface said "Your session ended. Type your
 * password once and this carries on." and gave the owner nowhere to type it.
 * The fix is structural, not a patch to one screen — the sentence now lives
 * HERE, beside the box, so nothing can print it without also offering the box.
 *
 * IT IS THE SAME PASSWORD, NOT A NEW SIGN-IN. The device is still attached to
 * the account; only the bearer token was thrown away. One field, one button —
 * never the claim sheet, which is what a person reaches for when an app says
 * their credentials failed and offers no other door.
 *
 * IT GOES STRAIGHT TO THE REGISTRY, not through the local unlock verifier. The
 * commonest way to arrive here is a password changed on the web, which leaves
 * that verifier holding the OLD password: checking against it first would
 * refuse the new password before cookrew.dev ever saw it.
 *
 * WHEN THE REGISTRY WANTS MORE (401 second_factor) the refusal says so and
 * points at the ladder — a device the account already trusts approves this
 * one. Phase 4 owns that flow; naming the wall beats a password box that will
 * refuse every attempt without saying which one was hit.
 */
export function ResumeSession({
  onResumed,
}: {
  onResumed: (status: AccountStatus) => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resume = (): void => {
    const call = cookrew().accountResume
    if (!call || busy || password.length === 0) return
    setBusy(true)
    setError(null)
    void call(password)
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          setPassword('')
          onResumed(result.value)
          return
        }
        // The reason is kept, not flattened: "wrong password", "cookrew.dev
        // did not answer" and "this needs a second factor" send a person to
        // three different places.
        setError(refusedSentence(DOING.RESUME, result))
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(problemSentence(DOING.RESUME, err))
      })
  }

  return (
    <section className="cr-acct-resume" aria-label="Your session ended">
      <p className="gs-consequence">{ACCOUNT_COPY.SESSION_ENDED}</p>
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
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
