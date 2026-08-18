// Making an interactive browser node survivable for a real sign-in flow.
//
// WHY THIS EXISTS
// ---------------
// Signing into Google inside a browser node stopped dead on:
//
//   Welcome / <account> / Verifying it's you… / Complete sign-in using your passkey
//
// and waited forever. Two separate falsehoods put it there, both measured
// against a live node instance:
//
//   User-Agent  Mozilla/5.0 (Macintosh; …) HeadlessChrome/151.0.0.0 Safari/…
//   PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() → true
//
// The first tells Google this is an automated browser, which is a documented
// reason for it to refuse or degrade a sign-in. The second is simply untrue:
// a headless Chrome has no Touch ID and no Secure Enclave, so there is no
// platform authenticator behind that promise. Google believed it, chose
// passkey as the method, and then nothing on this machine could ever answer.
//
// Neither is fixable by clicking harder. What IS fixable is the browser
// telling the truth about itself, so the site offers a method that can work.
//
// SCOPE — the strings and the CDP calls to correct those two claims. This
// module signs nothing in, stores no credential, and knows no account.

/**
 * A user agent without the automation tell.
 *
 * `HeadlessChrome/151.0.0.0` gives away two things: the word Headless, and a
 * build number of `.0.0` that no shipped Chrome has. `/json/version` reports
 * the REAL one (`Chrome/151.0.7922.138`), so prefer that and fall back to
 * merely dropping the word when it is unavailable.
 *
 * This is not evasion for its own sake — the browser genuinely is Chrome, on
 * this machine, driven by its owner. What it is not is a robot pretending to
 * be a person, and nothing here claims otherwise.
 */
export function presentableUserAgent(headlessUserAgent: string, browser?: string): string {
  const ua = headlessUserAgent.trim()
  if (ua.length === 0) return ua
  const real = /^Chrome\/[\d.]+$/.test((browser ?? '').trim()) ? browser!.trim() : null
  if (real) {
    const swapped = ua.replace(/HeadlessChrome\/[\d.]+/, real)
    if (swapped !== ua) return swapped
  }
  return ua.replace('HeadlessChrome/', 'Chrome/')
}

/**
 * Correct the platform-authenticator claim, before any page script runs.
 *
 * Reporting `false` is the honest answer for a browser with no biometric
 * hardware attached, and it is what makes a sign-in page offer a password or
 * a code instead of waiting on a passkey that can never arrive. Conditional
 * mediation goes with it: autofill-from-passkey has the same problem.
 *
 * Deliberately narrow. It does not touch navigator.webdriver, plugins, or any
 * of the other surfaces a bot-detection script reads — this exists to stop a
 * hang, not to defeat detection.
 */
export const NO_PLATFORM_AUTHENTICATOR = `
(() => {
  const pkc = window.PublicKeyCredential
  if (!pkc) return
  const no = () => Promise.resolve(false)
  try {
    Object.defineProperty(pkc, 'isUserVerifyingPlatformAuthenticatorAvailable', {
      value: no, configurable: true, writable: true
    })
    Object.defineProperty(pkc, 'isConditionalMediationAvailable', {
      value: no, configurable: true, writable: true
    })
  } catch {
    // A locked-down page. The WebAuthn domain below is the other half of
    // this and still makes an attempt fail fast rather than hang.
  }
})()
`

/** The subset of a CDP client this needs. */
export interface SignInCdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export interface SignInCompatOptions {
  /** UA to present, already de-headlessed. Skipped when empty. */
  userAgent: string
  /** Matches what the app itself requests, so the two never disagree. */
  acceptLanguage?: string
}

/**
 * Apply both corrections to one page target.
 *
 * Every step is individually best-effort: a browser build that lacks the
 * WebAuthn domain, or a target that dies mid-attach, must not take down the
 * page attach — the tab still works, it just keeps the old behaviour.
 */
export async function applySignInCompatibility(
  cdp: SignInCdp,
  options: SignInCompatOptions
): Promise<void> {
  if (options.userAgent.length > 0) {
    try {
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: options.userAgent,
        ...(options.acceptLanguage ? { acceptLanguage: options.acceptLanguage } : {}),
        platform: 'MacIntel'
      })
    } catch {
      // Older builds put this on Emulation only.
      try {
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
      } catch {
        // Leave the UA alone rather than fail the attach.
      }
    }
  }

  try {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: NO_PLATFORM_AUTHENTICATOR
    })
  } catch {
    // Ditto.
  }

  try {
    // With the domain on and NO virtual authenticator registered, a
    // credentials.get() rejects immediately instead of waiting on hardware
    // that does not exist. That turns the hang in the screenshot into a
    // fallback the page already knows how to offer.
    await cdp.send('WebAuthn.enable', { enableUI: false })
  } catch {
    // Not every build exposes it; the script above already did the work.
  }
}
