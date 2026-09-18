import { useEffect, useRef, useState } from 'react'
import type {
  AccountStatus,
  SecondFactorStep,
  UsernameCheck,
} from '../../../shared/account-v2'
import { normaliseUsername } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { DOING, problemSentence } from './problem'
import {
  ACCOUNT_COPY,
  crossingFor,
  migrateView,
  registerView,
  signInView,
  triesFor,
  type ClaimFields,
  type Landing,
  type SheetState,
  type TriesSpent,
} from './account-store'
import { LegacyPane, RegisterPane, SignInPane } from './SheetPanes'
import { ResumeLadder } from './ResumeLadder'
import '../grant-surface.css'

/**
 * THE ACCOUNT SHEET (D9) — one sheet from the avatar, three states.
 *
 * SIGN IN is the default tab: a person registers once and installs many
 * times. CREATE ACCOUNT is D2's fields under the other tab. LEGACY is the
 * phase-6 migration exactly as it was, decided by the status and not by a
 * tab — a Mac holding a v1 key has no choice to make, only a password to set.
 *
 * THE TABS ARE THE WAY BACK FROM A WRONG GUESS, AND A WRONG GUESS CROSSES ON
 * ITS OWN. Create a name that exists and the sheet becomes SIGN IN with the
 * name kept; sign in with a name nobody has and it becomes CREATE with the
 * name kept. Every one of those decisions is `crossingFor` in the store,
 * tested without this file; the component's whole job is to ask the bridge,
 * hand the answer to the store, and draw where it lands.
 *
 * THE AVAILABILITY CHECK RUNS ONLY ON THE CREATE SIDE. On SIGN IN it would
 * leak, one HEAD per keystroke, whether every name a person tries exists —
 * so the sign-in side asks exactly once, after a refused password, to tell
 * "wrong password" from "no such account".
 *
 * THE PASSWORD DOES NOT OUTLIVE THE ANSWER. Main keeps it for the length of
 * a ladder under the pending id; this component drops its copy the moment
 * the bridge answers, so a ladder card can be unmounted mid-climb without a
 * secret left in a closure.
 */

/** Long enough that a typist is not checking on every letter. */
const DEBOUNCE_MS = 350

/** Which door the sheet was finished through — the surface decides what follows. */
export type SheetDone = 'signin' | 'register' | 'legacy'

const TABS: readonly { state: 'signin' | 'register'; label: string }[] = [
  { state: 'signin', label: 'SIGN IN' },
  { state: 'register', label: 'CREATE ACCOUNT' },
]

const EMPTY: ClaimFields = { username: '', check: 'invalid', password: '', confirm: '' }

export function AccountSheet({
  initial = 'signin',
  legacy = null,
  onClose,
  onDone,
}: {
  /** The tab to open on. The first-run card's two buttons choose it. */
  initial?: 'signin' | 'register'
  /** The handle this Mac held before passwords, when it has one (phase 6). */
  legacy?: { handle: string } | null
  onClose: () => void
  onDone: (status: AccountStatus, via: SheetDone) => void
}): React.JSX.Element {
  const [state, setState] = useState<SheetState>(legacy === null ? initial : 'legacy')
  const [fields, setFields] = useState<ClaimFields>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The sentence a crossing left under the name, and the name it is about. */
  const [crossed, setCrossed] = useState<{ sentence: string; name: string } | null>(null)
  /**
   * Wrong passwords on the sign-in side, counted against the registry's
   * minute — and the name they were spent on. `triesFor` in the store decides
   * which count applies; this only holds its answer.
   */
  const [wrongTries, setWrongTries] = useState<TriesSpent>({ name: '', count: 0 })
  /** The ladder cookrew.dev opened (D10), or null while the password is the question. */
  const [ladder, setLadder] = useState<{ step: SecondFactorStep; lede: string } | null>(null)
  const field = useRef<HTMLInputElement>(null)

  // The first field, never the primary. Re-run on a crossing: the field the
  // person should be in changes with the state.
  useEffect(() => {
    field.current?.focus()
  }, [state])

  const typed = fields.username
  const name = normaliseUsername(typed)
  const crossing = crossed !== null && crossed.name === name ? crossed.sentence : null

  // AVAILABILITY, ON THE CREATE SIDE ONLY. Debounced, never guessed, and a
  // late answer for a name no longer typed decides nothing.
  useEffect(() => {
    const check = cookrew().accountCheck
    if (!check || state !== 'register') return
    if (name.length === 0) {
      setFields((prior) => ({ ...prior, check: 'invalid' }))
      return
    }
    setFields((prior) => ({ ...prior, check: 'checking' }))
    let live = true
    const timer = window.setTimeout(() => {
      void check(name)
        .then((answer: UsernameCheck) => {
          if (live)
            setFields((prior) => (prior.username === typed ? { ...prior, check: answer } : prior))
        })
        .catch(() => {
          if (live) setFields((prior) => ({ ...prior, check: 'unknown' }))
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [typed, state])

  /** Where a refusal lands: a crossing, a stay, or the ladder. */
  const land = (landing: Landing): void => {
    if (landing.kind === 'stay') {
      setError(landing.sentence)
      return
    }
    if (landing.kind === 'ladder') {
      // The ladder needs no step here: `land` is only reached with one from
      // the sign-in path, which sets it itself. Anything else is a stay.
      return
    }
    setError(null)
    setCrossed({ sentence: landing.sentence, name })
    setFields((prior) => ({ ...prior, password: '', confirm: '' }))
    setState(landing.to)
  }

  const signIn = (): void => {
    const call = cookrew().accountSignIn
    const view = signInView(fields, crossing)
    if (!call || busy || !view.canGo) return
    setBusy(true)
    setError(null)
    const password = fields.password
    void call({ username: name, password })
      .then(async (result) => {
        // Dropped either way, at once: from here on the ladder is addressed by
        // its pending id and main is the only party that needs it again.
        setFields((prior) => ({ ...prior, password: '' }))
        if (result.ok) {
          onDone(result.value, 'signin')
          return
        }
        if (result.reason === 'second_factor') {
          const landing = crossingFor({ state: 'signin', username: name, refusal: result })
          setLadder({ step: result.step, lede: landing.kind === 'ladder' ? landing.lede : '' })
          return
        }
        // A refused password is the one moment the sign-in side asks HEAD:
        // "wrong password" and "no such account" are two different doors.
        const refused = result.reason === 'bad_credentials' || result.reason === 'session-expired'
        const tries = triesFor(wrongTries, name, refused)
        setWrongTries(tries)
        const check = refused ? await availability(name) : null
        land(
          crossingFor({
            state: 'signin',
            username: name,
            refusal: result,
            check,
            wrongTries: tries.count,
          }),
        )
      })
      .catch((err: unknown) => setError(problemSentence(DOING.SIGN_IN, err)))
      .finally(() => setBusy(false))
  }

  const create = (): void => {
    const view = registerView(fields, crossing)
    /**
     * F2 · THE TAKEN NAME CROSSES ON THIS PRESS, and never reaches the wire.
     *
     * It lands through `crossingFor` with the same `taken` refusal a 409 from
     * POST /v2/accounts produces, so there is ONE crossing with two ways of
     * reaching it — the live check here, and the race where the check said
     * free and the registry disagreed. A second code path would be a second
     * idea of what crossing means.
     */
    if (view.crossesToSignIn) {
      if (busy) return
      land(crossingFor({ state: 'register', username: name, refusal: { reason: 'taken' } }))
      return
    }
    if (busy || !view.canClaim) return
    const asked = cookrew().accountClaim?.({ username: name, password: fields.password })
    if (!asked) return
    setBusy(true)
    setError(null)
    void asked
      .then((result) => {
        if (result.ok) onDone(result.value, 'register')
        else land(crossingFor({ state: 'register', username: name, refusal: result }))
      })
      .catch((err: unknown) => setError(problemSentence(DOING.CLAIM, err)))
      .finally(() => setBusy(false))
  }

  const migrate = (): void => {
    if (legacy === null) return
    const view = migrateView(fields, legacy.handle)
    if (busy || !view.canClaim) return
    const asked = cookrew().accountMigrate?.({ password: fields.password })
    if (!asked) return
    setBusy(true)
    setError(null)
    void asked
      .then((result) => {
        if (result.ok) onDone(result.value, 'legacy')
        else land(crossingFor({ state: 'register', username: legacy.handle, refusal: result }))
      })
      .catch((err: unknown) => setError(problemSentence(DOING.CLAIM, err)))
      .finally(() => setBusy(false))
  }

  const pane = paneFor(state)
  const title = state === 'legacy' ? 'Set a password' : 'Your Cookrew account'

  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="gs-sheet gs-small cr-sheet cr-acct-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>{title}</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {state !== 'legacy' && ladder === null && (
          <nav className="cr-acct-tabs" role="tablist" aria-label="Sign in or create">
            {TABS.map((tab) => (
              <button
                key={tab.state}
                role="tab"
                aria-selected={state === tab.state}
                className="cr-acct-tab"
                onClick={() => {
                  setError(null)
                  setState(tab.state)
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        {ladder !== null ? (
          <ResumeLadder
            step={ladder.step}
            lede={ladder.lede}
            onSignedIn={(status) => onDone(status, 'signin')}
            onOver={(sentence) => {
              // A ladder that went cold puts the password step back, with the reason.
              setLadder(null)
              setError(sentence)
            }}
          />
        ) : (
          <>
            {state === 'signin' && (
              <SignInPane
                fields={fields}
                view={signInView(fields, crossing)}
                field={field}
                onChange={(next) => setFields((prior) => ({ ...prior, ...next }))}
                onEnter={signIn}
              />
            )}
            {state === 'register' && (
              <RegisterPane
                fields={fields}
                view={registerView(fields, crossing)}
                field={field}
                onChange={setFields}
                onEnter={create}
              />
            )}
            {state === 'legacy' && legacy !== null && (
              <LegacyPane
                handle={legacy.handle}
                fields={fields}
                view={migrateView(fields, legacy.handle)}
                field={field}
                onChange={(next) => setFields((prior) => ({ ...prior, ...next }))}
                onEnter={migrate}
              />
            )}

            {error && (
              <p className="gs-paste-error" role="alert">
                {error}
              </p>
            )}

            <div className="gs-sheet-foot">
              <button className="gs-ghost" onClick={onClose}>
                NOT NOW
              </button>
              <button
                className="gs-primary"
                disabled={busy || !pane.canGo(fields, crossing, legacy)}
                onClick={state === 'signin' ? signIn : state === 'register' ? create : migrate}
              >
                {pane.primary(fields, crossing, legacy)}
              </button>
            </div>
            <p className="gs-foot-note">
              {state === 'legacy' ? ACCOUNT_COPY.LEGACY_KEEP_SERVING : ACCOUNT_COPY.NOT_NOW}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * HEAD once, after a refused password. A bridge without the call, or one
 * that throws, answers null — "do not guess" — and the sheet stays.
 */
async function availability(name: string): Promise<UsernameCheck | null> {
  const check = cookrew().accountCheck
  if (!check) return null
  try {
    return await check(name)
  } catch {
    return null
  }
}

/** The primary's label and gate, per state — read from the same views the panes draw. */
function paneFor(state: SheetState): {
  canGo: (fields: ClaimFields, crossing: string | null, legacy: { handle: string } | null) => boolean
  primary: (fields: ClaimFields, crossing: string | null, legacy: { handle: string } | null) => string
} {
  switch (state) {
    case 'signin':
      return {
        canGo: (fields, crossing) => signInView(fields, crossing).canGo,
        primary: (fields, crossing) => signInView(fields, crossing).primary,
      }
    case 'register':
      return {
        // `canGo`, not `canClaim`: on a taken name the primary is the way out
        // rather than a create, and "may be pressed" stopped meaning "will
        // create an account" (F2).
        canGo: (fields, crossing) => registerView(fields, crossing).canGo,
        primary: (fields, crossing) => registerView(fields, crossing).primary,
      }
    case 'legacy':
      return {
        canGo: (fields, _crossing, legacy) =>
          legacy !== null && migrateView(fields, legacy.handle).canClaim,
        primary: (fields, _crossing, legacy) =>
          legacy === null ? '' : migrateView(fields, legacy.handle).primary,
      }
  }
}
