import { useCallback, useEffect, useRef, useState } from 'react'
import './grant-surface.css'
import {
  CHECK_DEBOUNCE_MS,
  availabilityArrived,
  availabilityNote,
  canCreate,
  failedWith,
  initialSetup,
  mintedAs,
  shouldCheck,
  submitting,
  typeHandle,
  type Availability,
  type SetupState
} from './account-setup'

/**
 * PICK YOUR USERNAME — first run, one field.
 *
 * The account is the username, and the desktop app is the only thing that
 * mints one (D1): a browser and a phone bind to it, they never create it. So
 * this sheet is the whole of account creation, and it appears exactly once.
 *
 * IT IS PERMANENT, AND IT SAYS SO. First mint wins at the registry and nobody
 * holds a secret that can hand a name back, so the field checks availability
 * WHILE TYPING and the button is live only for a name the registry has just
 * said is free. Every decision about what the field claims lives in
 * account-setup.ts as a pure function, because the failure mode here is a
 * sentence being wrong.
 *
 * NO CANCEL. There is no state of this app in which "no username" is a thing
 * the owner chose — serving, calling and the phone all need one, and a sheet
 * that could be dismissed would leave the app in a condition every other
 * surface has to defend against forever.
 */

export interface AccountSetupSheetProps {
  /** The OS-derived suggestion. A suggestion, never an identity. */
  suggestion?: string
  /** Live availability. Returns the answer for exactly the handle it was given. */
  check: (handle: string) => Promise<Availability>
  mint: (handle: string) => Promise<{ ok: true; handle: string } | { ok: false; reason: string; kind?: string }>
  /** Called once, with the minted handle. The sheet closes itself. */
  onMinted: (handle: string) => void
}

export function AccountSetupSheet({
  suggestion = '',
  check,
  mint,
  onMinted
}: AccountSetupSheetProps): React.JSX.Element {
  const [state, setState] = useState<SetupState>(() => typeHandle(initialSetup(), suggestion))
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  // THE DEBOUNCE. One question per pause, and the answer is applied only if it
  // is still about what is in the field (availabilityArrived drops the rest).
  useEffect(() => {
    if (!shouldCheck(state)) return undefined
    const asked = state.handle
    const timer = setTimeout(() => {
      void check(asked)
        .then((availability) =>
          setState((current) => availabilityArrived(current, asked, availability))
        )
        .catch(() => setState((current) => availabilityArrived(current, asked, 'unknown')))
    }, CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [state.handle, state.availability, check])

  const create = useCallback((): void => {
    setState((current) => {
      if (!canCreate(current)) return current
      void mint(current.handle).then((result) =>
        setState((live) =>
          result.ok
            ? mintedAs(live, result.handle)
            : failedWith(live, result.reason, result.kind)
        )
      )
      return submitting(current)
    })
  }, [mint])

  useEffect(() => {
    if (state.minted !== null) onMinted(state.minted)
  }, [state.minted, onMinted])

  const ready = canCreate(state)
  const bad = state.availability === 'taken' || state.availability === 'invalid'

  return (
    <div className="gs-scrim" role="dialog" aria-modal="true" aria-label="Pick your username">
      <div
        className="gs-sheet gs-small"
        onKeyDown={(e) => {
          // Enter DOES fire here, unlike the enrol sheet: there is one field,
          // the button's precondition is a live availability check, and typing
          // a name then pressing Enter is the whole interaction.
          if (e.key === 'Enter' && ready) create()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Pick your username</h2>
        </header>
        <p className="gs-sub">
          It is your account everywhere Cookrew goes — your doors, your sessions, your phone. You
          pick it once and it cannot be changed by anyone else.
        </p>

        <label className="gs-label" htmlFor="acct-handle">
          Username
        </label>
        <input
          id="acct-handle"
          ref={field}
          className={`gs-input${bad ? ' gs-bad' : ''}`}
          value={state.handle}
          disabled={state.busy}
          spellCheck={false}
          autoComplete="off"
          placeholder="mira"
          aria-describedby="acct-note"
          onChange={(e) => setState((current) => typeHandle(current, e.target.value))}
        />
        <p
          id="acct-note"
          className={state.error !== null || bad ? 'gs-paste-error' : 'gs-hint'}
          role={state.error !== null ? 'alert' : 'status'}
        >
          {availabilityNote(state)}
        </p>

        <footer className="gs-sheet-foot">
          <button className="gs-primary" disabled={!ready} onClick={create}>
            {state.busy ? 'CLAIMING…' : 'CREATE'}
          </button>
        </footer>
        <p className="gs-foot-note">
          There is no password and no reset. Other devices you sign in on can bring this name back;
          nothing else can.
        </p>
      </div>
    </div>
  )
}
