import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MULTIPLEXER,
  DEFAULT_REGISTRY,
  envSwitch,
  interactiveBrowserDefault,
  multiInstanceDefault,
  multiplexerPreference,
  relayOrigin
} from '../src/main/launch-defaults'

/**
 * THE OWNER'S LAUNCH LINE IS THE PRODUCT DEFAULT (0.4.0).
 *
 *   COOKREW_REGISTRY=https://cookrew.dev COOKREW_INTERACTIVE_BROWSER=1
 *   COOKREW_MULTI_INSTANCE=1 COOKREW_MULTIPLEXER=herdr npm run dev
 *
 * A released app has no launch line, so each of these must hold with the
 * environment empty — and each must still be switchable OFF explicitly.
 */

const none = {}
const yes = () => true
const no = () => false

describe('envSwitch', () => {
  it('reads 1/true as on and 0/false as off, whatever the case', () => {
    expect(envSwitch('1', false)).toBe(true)
    expect(envSwitch('TRUE', false)).toBe(true)
    expect(envSwitch('0', true)).toBe(false)
    expect(envSwitch(' false ', true)).toBe(false)
  })

  it('falls back when unset, empty or unreadable', () => {
    expect(envSwitch(undefined, true)).toBe(true)
    expect(envSwitch('', false)).toBe(false)
    expect(envSwitch('maybe', true)).toBe(true)
  })
})

describe('with nothing set, the app launches the way the owner does', () => {
  it('serves through the registry’s API host', () => {
    // 0.6.0: cookrew.dev is a static site. The registry (accounts, doors, the relay) answers at api.cookrew.dev.
    expect(DEFAULT_REGISTRY).toBe('https://api.cookrew.dev')
    expect(relayOrigin(none)).toBe('https://api.cookrew.dev')
  })

  it('a launch line or a saved choice that still names the old address is read as the new one: the old one is a static site now', () => {
    expect(relayOrigin({ COOKREW_REGISTRY: 'https://cookrew.dev' })).toBe('https://api.cookrew.dev')
    expect(relayOrigin({ COOKREW_REGISTRY: 'https://COOKREW.dev/' })).toBe('https://api.cookrew.dev')
    // Anything else is what it says, and empty still means no relay.
    expect(relayOrigin({ COOKREW_REGISTRY: 'https://registry.example' })).toBe('https://registry.example')
    expect(relayOrigin({ COOKREW_REGISTRY: 'https://cookrew.dev.evil.example' })).toBe('https://cookrew.dev.evil.example')
    expect(relayOrigin({ COOKREW_REGISTRY: '' })).toBe('')
  })

  it('holds every workspace live at once', () => {
    expect(multiInstanceDefault(none)).toBe(true)
  })

  it('hosts terminals in herdr', () => {
    expect(DEFAULT_MULTIPLEXER).toBe('herdr')
    expect(multiplexerPreference(none)).toBe('herdr')
  })

  it('drives browsers headless when a Chrome is there to drive', () => {
    expect(interactiveBrowserDefault(none, yes)).toBe(true)
  })

  it('keeps the webview browser on a machine with no Chrome', () => {
    expect(interactiveBrowserDefault(none, no)).toBe(false)
  })
})

describe('every default can still be overridden', () => {
  it('an empty COOKREW_REGISTRY turns the relay off; another origin moves it', () => {
    expect(relayOrigin({ COOKREW_REGISTRY: '' })).toBe('')
    expect(relayOrigin({ COOKREW_REGISTRY: 'http://127.0.0.1:8799' })).toBe('http://127.0.0.1:8799')
  })

  it('COOKREW_MULTI_INSTANCE=0 restores one workspace at a time', () => {
    expect(multiInstanceDefault({ COOKREW_MULTI_INSTANCE: '0' })).toBe(false)
  })

  it('COOKREW_INTERACTIVE_BROWSER=0 turns headless pages off; =1 cannot conjure a Chrome', () => {
    expect(interactiveBrowserDefault({ COOKREW_INTERACTIVE_BROWSER: '0' }, yes)).toBe(false)
    expect(interactiveBrowserDefault({ COOKREW_INTERACTIVE_BROWSER: '1' }, yes)).toBe(true)
    expect(interactiveBrowserDefault({ COOKREW_INTERACTIVE_BROWSER: '1' }, no)).toBe(false)
  })

  it('COOKREW_MULTIPLEXER picks another host', () => {
    expect(multiplexerPreference({ COOKREW_MULTIPLEXER: 'tmux' })).toBe('tmux')
  })

  it('never probes for Chrome when the switch is off', () => {
    const probe = () => {
      throw new Error('probed')
    }
    expect(interactiveBrowserDefault({ COOKREW_INTERACTIVE_BROWSER: '0' }, probe)).toBe(false)
  })
})
