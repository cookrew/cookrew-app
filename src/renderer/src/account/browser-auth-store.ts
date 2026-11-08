import type { AccountResult, AccountStatus, SignInAnswer } from '../../../shared/account-v2'
import { hostPlatform, machineTable } from '../../../shared/machine-words'
import type { ProviderId } from '../../../shared/oauth'
import { DOING, problemSentence } from './problem'
import { providerRefusal, type tripGuard } from './provider-store'

/**
 * THE ONE SIGN-IN PAGE, AS THE SHEETS USE IT: words and verdicts.
 *
 * Main runs the whole trip (account-browser-auth.ts); a sheet starts it, shows
 * the wait, and reads how it ended. One answer is special: 'unsupported' is a
 * registry with no page, and it is remembered for this run so every sheet goes
 * straight back to what it was before the page existed, forms and all.
 */

/** The screens the page may open on. */
export type PageIntent = 'sign-in' | 'create' | 'github' | 'google'

export const BROWSER_COPY = machineTable(
  {
    WAITING: 'Continue in your browser.',
    WAITING_WHY: 'Finish there and this carries on by itself.',
    SIGN_IN: 'SIGN IN IN YOUR BROWSER',
    CREATE: 'CREATE IN YOUR BROWSER',
    RESUME: 'SIGN IN AGAIN IN YOUR BROWSER',
    SIGN_IN_LEDE:
      'Your browser opens the Cookrew sign-in page: a password, a passkey or a provider. What you type there never reaches this app.',
    CREATE_LEDE: 'Your browser opens the Cookrew sign-in page to choose your name and how you sign in.',
    SESSION_ENDED: 'Your session ended. Sign in once in your browser and this carries on.',
  } as const,
  hostPlatform(),
)

/** A registry said it has no page. For this run, every sheet goes the old way. */
let missing = false

export const pageKnownMissing = (): boolean => missing

/** For a test, and for nothing else: the next sheet asks again. */
export const forgetPageMissing = (): void => {
  missing = false
}

/** Does this bridge offer the page for this act, and has no registry refused it? */
export const pageOffered = (call: unknown): boolean => call !== undefined && !missing

type Guard = ReturnType<typeof tripGuard>

/**
 * ONE TRIP TO THE PAGE, from the press to where it lands.
 *
 * The guard is held for exactly the length of the trip, so a sheet closing
 * mid-trip cancels it; it is let go before any handler runs, so a fallback may
 * start the old trip at once.
 */
export async function runPageTrip(
  call: () => Promise<SignInAnswer<AccountStatus>>,
  guard: Guard,
  on: {
    done: (status: AccountStatus) => void
    fallback: () => void
    /** Null is "say nothing": changing your mind in a browser is not a failure. */
    refused: (sentence: string | null) => void
  },
): Promise<void> {
  const from = guard.begin()
  let answer: SignInAnswer<AccountStatus>
  try {
    answer = await call()
  } catch (error) {
    guard.end(from)
    on.refused(problemSentence(DOING.SIGN_IN, error))
    return
  }
  guard.end(from)
  if (answer.ok) {
    on.done(answer.value)
    return
  }
  if (answer.reason === 'unsupported') {
    missing = true
    on.fallback()
    return
  }
  on.refused(providerRefusal(answer.reason, answer.message))
}

type LinkCall = (input: { provider: ProviderId; current?: string; rescue?: string }) => Promise<AccountResult<void>>

/**
 * WHICH CALL A LINK ROW MAKES. A link goes to the page when the bridge offers
 * it; main falls back to the provider trip with the same proof when the
 * registry has no page, so a rescue code is never asked for twice. An unlink
 * opens no browser and is unchanged.
 */
export function linkCallFor(
  api: { accountBrowserLink?: LinkCall; accountOAuthLink?: LinkCall; accountOAuthUnlink?: LinkCall },
  verb: 'link' | 'unlink',
): LinkCall | undefined {
  if (verb === 'unlink') return api.accountOAuthUnlink
  return pageOffered(api.accountBrowserLink) ? api.accountBrowserLink : api.accountOAuthLink
}
