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
// Correcting those two exposed two more, measured on Chrome 156 against Google:
//
//   navigator.userAgentData.brands → []
//   navigator.credentials.get()    → NotAllowedError after 180,206 ms
//
// The first is a side effect of the UA fix: an override without metadata
// empties navigator.userAgentData and drops every Sec-CH-UA header, so the page
// sees a UA that says Chrome and hints that say nothing. Chrome knows its real
// brands, build, OS and CPU, so they are read from Chrome and handed back as
// they are. Nothing here is composed or guessed.
//
// The second means a passkey page sat on "Verifying it's you…" for three
// minutes, and its Continue button bought three more. See the script below.
//
// SCOPE — the strings and the CDP calls to correct those claims. This module
// signs nothing in, stores no credential, and knows no account.

import { CdpClient } from './cdp-client'

/**
 * A user agent without the automation tell.
 *
 * Only the word goes. `Chrome/151.0.0.0` stays exactly as Chrome reduced it,
 * because that is what every shipped Chrome sends; the full build lives in the
 * client hints, where sites look for it.
 *
 * This is not evasion for its own sake — the browser genuinely is Chrome, on
 * this machine, driven by its owner. What it is not is a robot pretending to
 * be a person, and nothing here claims otherwise.
 */
export function presentableUserAgent(headlessUserAgent: string): string {
  return headlessUserAgent.trim().replace('HeadlessChrome/', 'Chrome/')
}

interface BrandVersion {
  brand: string
  version: string
}

/** CDP's Emulation.UserAgentMetadata, filled only from what Chrome reported. */
export interface UserAgentMetadata {
  brands: BrandVersion[]
  fullVersionList: BrandVersion[]
  fullVersion: string
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitness: string
  wow64: boolean
  formFactors: string[]
}

/** What this browser says about itself before any override touches it. */
export interface NativeIdentity {
  navigatorPlatform: string
  metadata: UserAgentMetadata
}

/**
 * userAgentData exists only in a secure context, so about:blank has none, and
 * the tab a card opens on may be plain http. This page always qualifies and
 * needs no network.
 */
export const IDENTITY_PROBE_URL = 'chrome://version'

/** Evaluates to a JSON string, or undefined while the page has no userAgentData. */
export const NATIVE_IDENTITY_EXPRESSION = `
(async () => {
  const data = navigator.userAgentData
  if (!data) return undefined
  const values = await data.getHighEntropyValues([
    'architecture', 'bitness', 'formFactors', 'fullVersionList', 'model',
    'platform', 'platformVersion', 'uaFullVersion', 'wow64'
  ])
  return JSON.stringify({ navPlatform: navigator.platform, ...values })
})()
`

const isBrandList = (value: unknown): value is BrandVersion[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (entry: Partial<BrandVersion> | null) =>
      typeof entry?.brand === 'string' && typeof entry?.version === 'string'
  )

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Null unless the reply carries real brands. Handing CDP an empty list would
 * reproduce the exact bug this exists to fix, and a malformed one fails the
 * whole override.
 */
export function parseNativeIdentity(reply: unknown): NativeIdentity | null {
  if (typeof reply !== 'string') return null
  let values: Record<string, unknown> | null
  try {
    values = JSON.parse(reply) as Record<string, unknown> | null
  } catch {
    return null
  }
  if (!values || !isBrandList(values.brands) || !isBrandList(values.fullVersionList)) return null
  return {
    navigatorPlatform: text(values.navPlatform),
    metadata: {
      brands: values.brands,
      fullVersionList: values.fullVersionList,
      fullVersion: text(values.uaFullVersion),
      platform: text(values.platform),
      platformVersion: text(values.platformVersion),
      architecture: text(values.architecture),
      model: text(values.model),
      mobile: values.mobile === true,
      bitness: text(values.bitness),
      wow64: values.wow64 === true,
      formFactors: Array.isArray(values.formFactors) ? values.formFactors.map(text) : []
    }
  }
}

/** The subset of a CDP client this needs. */
export interface SignInCdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

/** A throwaway page the identity is read from. */
export interface IdentityProbePage {
  evaluate: (expression: string) => Promise<unknown>
  close: () => Promise<void>
}

export interface IdentityProbe {
  open: (url: string) => Promise<IdentityProbePage>
}

export interface IdentityProbeTiming {
  attempts?: number
  pollMs?: number
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function pollIdentity(
  page: IdentityProbePage,
  { attempts = 40, pollMs = 25 }: IdentityProbeTiming
): Promise<NativeIdentity | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const identity = parseNativeIdentity(await page.evaluate(NATIVE_IDENTITY_EXPRESSION))
    if (identity) return identity
    await pause(pollMs)
  }
  return null
}

/**
 * Best-effort, like everything else on this path: null costs a card its client
 * hints, which is what it had before, and must never cost it its startup.
 */
export async function readNativeIdentity(
  probe: IdentityProbe,
  timing: IdentityProbeTiming = {}
): Promise<NativeIdentity | null> {
  let page: IdentityProbePage | null = null
  try {
    page = await probe.open(IDENTITY_PROBE_URL)
    return await pollIdentity(page, timing)
  } catch {
    return null
  } finally {
    await page?.close().catch(() => undefined)
  }
}

/** Opens the probe page as a background target of the browser at `browser`. */
export function cdpIdentityProbe(
  browser: SignInCdp,
  debuggerUrl: (targetId: string) => Promise<string | undefined>
): IdentityProbe {
  return {
    open: async (url) => {
      const created = (await browser.send('Target.createTarget', { url, background: true })) as
        | { targetId?: string }
        | undefined
      const targetId = created?.targetId
      if (!targetId) throw new Error('Chrome did not create a probe page')
      const cdp = new CdpClient()
      const close = async (): Promise<void> => {
        cdp.close()
        await browser.send('Target.closeTarget', { targetId })
      }
      try {
        const address = await debuggerUrl(targetId)
        if (!address) throw new Error('probe page has no debugger URL')
        await cdp.connect(address)
      } catch (error) {
        await close().catch(() => undefined)
        throw error
      }
      return {
        close,
        evaluate: async (expression) => {
          const reply = (await cdp.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true
          })) as { result?: { value?: unknown } }
          return reply.result?.value
        }
      }
    }
  }
}

/**
 * Correct the platform-authenticator claim, before any page script runs.
 *
 * Reporting `false` is the honest answer for a browser with no biometric
 * hardware attached, and it is what makes a sign-in page offer a password or
 * a code instead of waiting on a passkey that can never arrive. Conditional
 * mediation goes with it: autofill-from-passkey has the same problem.
 *
 * Some pages ask anyway. Google calls credentials.get() for an account with a
 * passkey whatever the probes say, with a timeout of 180 s, and nothing on this
 * machine can answer or cancel it. So a request fails at once with the same
 * NotAllowedError it would reach three minutes later, and the page moves on.
 * Conditional requests are left alone: waiting quietly is their whole contract.
 *
 * Deliberately narrow. It does not touch navigator.webdriver, plugins, or any
 * of the other surfaces a bot-detection script reads — this exists to stop a
 * hang, not to defeat detection.
 *
 * navigator.webdriver is handled elsewhere, at launch: since 2026-11-08 (owner
 * ruling) headlessLaunchArgs turns off the AutomationControlled blink feature,
 * because the debugging port alone set it and Google refused sign-in on it.
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
    // A locked-down page. The requests below are the half that stops the wait.
  }
  const credentials = window.navigator && window.navigator.credentials
  if (!credentials) return
  const refuse = (name) => {
    const native = credentials[name].bind(credentials)
    credentials[name] = (options) =>
      options && options.publicKey && options.mediation !== 'conditional'
        ? Promise.reject(new DOMException('No authenticator on this machine.', 'NotAllowedError'))
        : native(options)
  }
  try {
    refuse('get')
    refuse('create')
  } catch {
    // Ditto: the page keeps the native wait.
  }
})()
`

export interface SignInCompatOptions {
  /** UA to present, already de-headlessed. Skipped when empty. */
  userAgent: string
  /** Absent when it could not be read: the UA still goes, the hints do not. */
  identity?: NativeIdentity | null
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
    const identity = options.identity
    const metadata = identity ? { userAgentMetadata: identity.metadata } : {}
    try {
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: options.userAgent,
        ...(options.acceptLanguage ? { acceptLanguage: options.acceptLanguage } : {}),
        ...(identity?.navigatorPlatform ? { platform: identity.navigatorPlatform } : {}),
        ...metadata
      })
    } catch {
      // Older builds put this on Emulation only.
      try {
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent: options.userAgent,
          ...metadata
        })
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
    // With the domain on and NO virtual authenticator registered, nothing
    // real is prompted on a Mac no one may be sitting at. It does NOT make a
    // request fail: one that gets this far waits out its whole timeout.
    await cdp.send('WebAuthn.enable', { enableUI: false })
  } catch {
    // Not every build exposes it; the script above already did the work.
  }
}
