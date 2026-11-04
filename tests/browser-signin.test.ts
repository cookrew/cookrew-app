import { describe, expect, it } from 'vitest'
import {
  applySignInCompatibility,
  NO_PLATFORM_AUTHENTICATOR,
  parseNativeIdentity,
  presentableUserAgent,
  readNativeIdentity,
  type IdentityProbe,
  type NativeIdentity
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
 *
 * Correcting those exposed two more, measured on Chrome 156 against Google:
 *
 *   navigator.userAgentData.brands → []   (a UA override drops client hints)
 *   navigator.credentials.get()    → NotAllowedError after 180,206 ms
 */

const HEADLESS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36'

/** Read off Chrome 156 on an M1 Pro, before any override touched it. */
const NATIVE_VALUES = {
  navPlatform: 'MacIntel',
  architecture: 'arm',
  bitness: '64',
  brands: [
    { brand: 'Not:A-Brand', version: '8' },
    { brand: 'Chromium', version: '156' },
    { brand: 'Google Chrome', version: '156' }
  ],
  formFactors: ['Desktop'],
  fullVersionList: [
    { brand: 'Not:A-Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: '156.0.8078.80' },
    { brand: 'Google Chrome', version: '156.0.8078.80' }
  ],
  mobile: false,
  model: '',
  platform: 'macOS',
  platformVersion: '26.5.1',
  uaFullVersion: '156.0.8078.80',
  wow64: false
}

const NATIVE_IDENTITY = parseNativeIdentity(JSON.stringify(NATIVE_VALUES)) as NativeIdentity

describe('presentableUserAgent', () => {
  it('drops the word and keeps the version exactly as Chrome reduced it', () => {
    // `.0.0` is what every shipped Chrome sends since UA reduction. Writing the
    // full build in here is what made the string unlike any real Chrome.
    expect(presentableUserAgent(HEADLESS_UA)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    )
  })

  it('leaves an already-clean agent and an empty one alone', () => {
    const clean = 'Mozilla/5.0 (Macintosh) Chrome/151.0.0.0 Safari/537.36'
    expect(presentableUserAgent(clean)).toBe(clean)
    expect(presentableUserAgent('')).toBe('')
  })
})

describe('parseNativeIdentity', () => {
  it('carries what the browser said into the CDP metadata shape, unchanged', () => {
    expect(NATIVE_IDENTITY).toEqual({
      navigatorPlatform: 'MacIntel',
      metadata: {
        brands: NATIVE_VALUES.brands,
        fullVersionList: NATIVE_VALUES.fullVersionList,
        fullVersion: '156.0.8078.80',
        platform: 'macOS',
        platformVersion: '26.5.1',
        architecture: 'arm',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
        formFactors: ['Desktop']
      }
    })
  })

  it('refuses a page with no userAgentData, or a reply it cannot read', () => {
    expect(parseNativeIdentity(undefined)).toBeNull()
    expect(parseNativeIdentity('not json')).toBeNull()
    expect(parseNativeIdentity('null')).toBeNull()
    expect(parseNativeIdentity(JSON.stringify({ navPlatform: 'MacIntel' }))).toBeNull()
  })

  it('refuses empty brands: passing those on is the very bug this replaces', () => {
    expect(parseNativeIdentity(JSON.stringify({ ...NATIVE_VALUES, brands: [] }))).toBeNull()
  })

  it('refuses a malformed brand rather than handing CDP a bad struct', () => {
    expect(
      parseNativeIdentity(JSON.stringify({ ...NATIVE_VALUES, brands: [{ brand: 'Chromium' }] }))
    ).toBeNull()
  })
})

describe('readNativeIdentity', () => {
  const probe = (
    answers: unknown[],
    overrides: Partial<IdentityProbe> = {}
  ): { probe: IdentityProbe; log: string[] } => {
    const log: string[] = []
    let asked = 0
    return {
      log,
      probe: {
        open: (url) => {
          log.push(`open ${url}`)
          return Promise.resolve({
            evaluate: () => Promise.resolve(answers[Math.min(asked++, answers.length - 1)]),
            close: () => {
              log.push('close')
              return Promise.resolve()
            }
          })
        },
        ...overrides
      }
    }
  }

  it('reads the identity from a page that has userAgentData, then closes it', async () => {
    const { probe: p, log } = probe([JSON.stringify(NATIVE_VALUES)])
    await expect(readNativeIdentity(p, { pollMs: 0 })).resolves.toEqual(NATIVE_IDENTITY)
    expect(log).toEqual(['open chrome://version', 'close'])
  })

  it('waits for a page still loading', async () => {
    const { probe: p } = probe([undefined, undefined, JSON.stringify(NATIVE_VALUES)])
    await expect(readNativeIdentity(p, { pollMs: 0 })).resolves.toEqual(NATIVE_IDENTITY)
  })

  it('gives up with null, and still closes the page', async () => {
    const { probe: p, log } = probe([undefined])
    await expect(readNativeIdentity(p, { pollMs: 0, attempts: 3 })).resolves.toBeNull()
    expect(log).toContain('close')
  })

  it('never throws into startup, whatever the browser does', async () => {
    const { probe: refused } = probe([], {
      open: () => Promise.reject(new Error('no chrome:// here'))
    })
    await expect(readNativeIdentity(refused, { pollMs: 0 })).resolves.toBeNull()

    const { probe: dying } = probe([], {
      open: () =>
        Promise.resolve({
          evaluate: () => Promise.reject(new Error('target closed')),
          close: () => Promise.reject(new Error('already gone'))
        })
    })
    await expect(readNativeIdentity(dying, { pollMs: 0 })).resolves.toBeNull()
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

  describe('a passkey request nothing here can answer', () => {
    const page = (): {
      win: { PublicKeyCredential: object; navigator: { credentials: Record<string, (o?: unknown) => Promise<string>> } }
      reached: string[]
    } => {
      const reached: string[] = []
      const native = (name: string) => () => {
        reached.push(name)
        return Promise.resolve(`native ${name}`)
      }
      const win = {
        PublicKeyCredential: {},
        navigator: { credentials: { get: native('get'), create: native('create') } }
      }
      new Function('window', NO_PLATFORM_AUTHENTICATOR)(win)
      return { win, reached }
    }

    it('fails at once instead of waiting out the page timeout', async () => {
      // Measured on Google: timeout 180000, and get() sat there for 180,206 ms
      // before NotAllowedError, once for the page and again for its Continue.
      const { win, reached } = page()
      await expect(win.navigator.credentials.get({ publicKey: {} })).rejects.toMatchObject({
        name: 'NotAllowedError'
      })
      await expect(win.navigator.credentials.create({ publicKey: {} })).rejects.toMatchObject({
        name: 'NotAllowedError'
      })
      expect(reached).toEqual([])
    })

    it('leaves conditional passkey autofill to wait, as that request is meant to', async () => {
      const { win, reached } = page()
      await win.navigator.credentials.get({ publicKey: {}, mediation: 'conditional' })
      expect(reached).toEqual(['get'])
    })

    it('leaves stored passwords and federated credentials alone', async () => {
      const { win, reached } = page()
      await expect(win.navigator.credentials.get({ password: true })).resolves.toBe('native get')
      await expect(win.navigator.credentials.create({ password: {} })).resolves.toBe('native create')
      expect(reached).toEqual(['get', 'create'])
    })
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
    // Enabled with NO virtual authenticator: nothing real is ever prompted.
    expect(params[2]).toEqual({ enableUI: false })
  })

  it('hands the browser its own client hints back with the UA', async () => {
    // Overriding the UA alone empties navigator.userAgentData and drops every
    // Sec-CH-UA header. A page then sees a browser with no brand at all.
    const { cdp, params } = recorder()
    await applySignInCompatibility(cdp, { userAgent: 'Chrome/151', identity: NATIVE_IDENTITY })
    expect(params[0].userAgentMetadata).toEqual(NATIVE_IDENTITY.metadata)
    expect(params[0].platform).toBe('MacIntel')
  })

  it('claims no platform or metadata it never read', async () => {
    const { cdp, params } = recorder()
    await applySignInCompatibility(cdp, { userAgent: 'Chrome/151', identity: null })
    expect(params[0]).toEqual({ userAgent: 'Chrome/151' })
  })

  it('falls back to Emulation when Network has no override', async () => {
    const { cdp, sent, params } = recorder(['Network.setUserAgentOverride'])
    await applySignInCompatibility(cdp, { userAgent: 'Chrome/151', identity: NATIVE_IDENTITY })
    expect(sent).toContain('Emulation.setUserAgentOverride')
    expect(params[0].userAgentMetadata).toEqual(NATIVE_IDENTITY.metadata)
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
