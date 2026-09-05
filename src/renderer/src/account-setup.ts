/**
 * PICK YOUR USERNAME — the first-run sheet, as a value.
 *
 * The username is minted once and cannot be taken back, so the field has to be
 * honest BEFORE the button is pressed: a name that is already taken says so
 * while you type, a name that is not a handle says what a handle is, and a
 * registry we cannot reach says THAT rather than "available".
 *
 * All of it lives here, with no React and no fetch, because the failure this
 * guards against is a sentence being wrong — and a sentence is testable only
 * when it is a return value.
 */

export type Availability = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'unknown'

export interface SetupState {
  /** Exactly what the person typed, normalised (`@Mira ` → `mira`). */
  handle: string
  availability: Availability
  /** True while the mint is in flight; the button and field are frozen. */
  busy: boolean
  /** A refusal, as a sentence. */
  error: string | null
  /** The minted handle. Non-null means the sheet is finished. */
  minted: string | null
}

/** How long the field waits before asking the registry. */
export const CHECK_DEBOUNCE_MS = 350

/** The shape the registry holds a handle to. Mirrors account.ts HANDLE_SHAPE. */
export const HANDLE_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

export function normaliseHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '')
}

export function initialSetup(suggestion = ''): SetupState {
  return {
    handle: normaliseHandle(suggestion),
    availability: 'idle',
    busy: false,
    error: null,
    minted: null
  }
}

/**
 * A keystroke. The old availability is DROPPED, not kept while the new name is
 * checked — a field that still reads "available" under a name nobody has
 * checked yet is the one lie this sheet cannot afford.
 */
export function typeHandle(state: SetupState, raw: string): SetupState {
  const handle = normaliseHandle(raw)
  if (handle === state.handle) return state
  return {
    ...state,
    handle,
    availability: handle.length === 0 ? 'idle' : HANDLE_SHAPE.test(handle) ? 'checking' : 'invalid',
    error: null
  }
}

/**
 * An answer arrived. Ignored unless it is about the name in the field — a slow
 * reply for a name the person has already typed past would otherwise mark a
 * different name taken.
 */
export function availabilityArrived(
  state: SetupState,
  forHandle: string,
  availability: Availability
): SetupState {
  if (normaliseHandle(forHandle) !== state.handle) return state
  return { ...state, availability }
}

export function submitting(state: SetupState): SetupState {
  return { ...state, busy: true, error: null }
}

export function mintedAs(state: SetupState, handle: string): SetupState {
  return { ...state, busy: false, error: null, minted: normaliseHandle(handle) }
}

/**
 * A refusal. `handle-taken` also moves the FIELD, not just the message: the
 * registry has just told us something the field was claiming otherwise.
 */
export function failedWith(state: SetupState, reason: string, kind?: string): SetupState {
  return {
    ...state,
    busy: false,
    error: reason,
    availability: kind === 'handle-taken' ? 'taken' : state.availability
  }
}

/** Is the button live? Only for a name the registry has said is free. */
export function canCreate(state: SetupState): boolean {
  return !state.busy && state.minted === null && state.availability === 'free'
}

/** Should the field ask the registry about what is currently typed? */
export function shouldCheck(state: SetupState): boolean {
  return state.availability === 'checking' && HANDLE_SHAPE.test(state.handle)
}

/**
 * What the field says under itself. One sentence per state, and never an empty
 * reassurance: 'unknown' is a real answer and gets its own words.
 */
export function availabilityNote(state: SetupState): string {
  if (state.error !== null) return state.error
  switch (state.availability) {
    case 'idle':
      return 'Pick a username. It is how doors, teams and calls will know you.'
    case 'checking':
      return `Checking @${state.handle}…`
    case 'free':
      return `@${state.handle} is free. It is yours the moment you press Create.`
    case 'taken':
      return `@${state.handle} is taken — try another name.`
    case 'invalid':
      return '1–32 lowercase letters, digits or dashes, not starting or ending with a dash.'
    case 'unknown':
      return 'The registry did not answer, so this name cannot be checked yet.'
  }
}
