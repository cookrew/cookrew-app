import { describe, expect, it } from 'vitest'
import {
  applySignInCompatibility,
  NO_PLATFORM_AUTHENTICATOR,
  presentableUserAgent
} from '../src/main/browser-signin'

/**
 * Both strings below were read off a LIVE browser node, and both are why a
 * Google sign-in inside one stopped at "Verifying it's you… Complete sign-in
 * using your passkey" and never moved:
 *
 *   Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
 *     (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36
 *   PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() → true
 *
 * The second is the fatal one: headless Chrome has no Touch ID, so the promise
 * it makes there can never be kept, and the page waits on it forever.
 */

const HEADLESS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36'

describe('presentableUserAgent', () => {
  it('swaps in the real Chrome version reported by /json/version', () => {
    // `151.0.0.0` is itself a tell — no shipped Chrome has that build number.
    expect(presentableUserAgent(HEADLESS_UA, 'Chrome/151.0.7922.138')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/151.0.7922.138 Safari/537.36'
    )
  })

  it('at least drops the word when no real version is available', () => {
    expect(presentableUserAgent(HEADLESS_UA)).toContain('Chrome/151.0.0.0')
    expect(presentableUserAgent(HEADLESS_UA)).not.toContain('Headless')
  })

  it('ignores a nonsense browser string rather than pasting it in', () => {
    const out = presentableUserAgent(HEADLESS_UA, 'not a version')
    expect(out).not.toContain('not a version')
    expect(out).not.toContain('Headless')
  })

  it('leaves an already-clean agent and an empty one alone', () => {
    const clean = 'Mozilla/5.0 (Macintosh) Chrome/151.0.7922.138 Safari/537.36'
    expect(presentableUserAgent(clean, 'Chrome/151.0.7922.138')).toBe(clean)
    expect(presentableUserAgent('')).toBe('')
  })
})

describe('NO_PLATFORM_AUTHENTICATOR', () => {
  it('makes both availability probes answer false', async () => {
    // Run the real script against a stand-in of the API it patches.
    const win = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
        isConditionalMediationAvailable: () => Promise.resolve(true)
      }
    }
    new Function('window', NO_PLATFORM_AUTHENTICATOR)(win)
    await expect(
      win.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    ).resolves.toBe(false)
    await expect(win.PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(false)
  })

  it('does nothing on a browser without WebAuthn at all', () => {
    expect(() => new Function('window', NO_PLATFORM_AUTHENTICATOR)({})).not.toThrow()
  })

  it('leaves the rest of the automation surface untouched', () => {
    // This exists to stop a hang, not to defeat bot detection. Touching
    // navigator.webdriver or plugins would be a different thing entirely.
    expect(NO_PLATFORM_AUTHENTICATOR).not.toContain('webdriver')
    expect(NO_PLATFORM_AUTHENTICATOR).not.toContain('plugins')
  })
})

describe('applySignInCompatibility', () => {
  const recorder = (failing: string[] = []): { sent: string[]; cdp: { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> }; params: Record<string, unknown>[] } => {
    const sent: string[] = []
    const params: Record<string, unknown>[] = []
    return {
      sent,
      params,
      cdp: {
        send: (method, param) => {
          if (failing.includes(method)) return Promise.reject(new Error(`${method} unsupported`))
          sent.push(method)
          params.push(param ?? {})
          return Promise.resolve({})
        }
      }
    }
  }

  it('overrides the UA, installs the script, and enables WebAuthn', async () => {
    const { cdp, sent, params } = recorder()
    await applySignInCompatibility(cdp, { userAgent: 'Chrome/151' })
    expect(sent).toEqual([
      'Network.setUserAgentOverride',
      'Page.addScriptToEvaluateOnNewDocument',
      'WebAuthn.enable'
    ])
    expect(params[0].userAgent).toBe('Chrome/151')
    // Enabled with NO virtual authenticator: a credentials.get() then rejects
    // at once instead of waiting on hardware that does not exist.
    expect(params[2]).toEqual({ enableUI: false })
  })

  it('falls back to Emulation when Network has no override', async () => {
    const { cdp, sent } = recorder(['Network.setUserAgentOverride'])
    await applySignInCompatibility(cdp, { userAgent: 'Chrome/151' })
    expect(sent).toContain('Emulation.setUserAgentOverride')
  })

  it('skips the UA entirely when there is none to present', async () => {
    const { cdp, sent } = recorder()
    await applySignInCompatibility(cdp, { userAgent: '' })
    expect(sent).not.toContain('Network.setUserAgentOverride')
    expect(sent).toContain('Page.addScriptToEvaluateOnNewDocument')
  })

  it('never throws, whatever the browser refuses', async () => {
    // This runs inside page attach. A build without the WebAuthn domain, or a
    // target dying mid-attach, must cost the tab nothing.
    const { cdp } = recorder([
      'Network.setUserAgentOverride',
      'Emulation.setUserAgentOverride',
      'Page.addScriptToEvaluateOnNewDocument',
      'WebAuthn.enable'
    ])
    await expect(
      applySignInCompatibility(cdp, { userAgent: 'Chrome/151' })
    ).resolves.toBeUndefined()
  })
})
