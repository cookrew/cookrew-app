// THE TWO MAGPIE SWITCHES, IN MAIN. Every route choice and every dispatch asks
// again; a route that can reach another computer's Magpie (its own models, a
// group with one of them in it, a provider that falls back to one) is refused
// while "Magpie remote" is off, and anything main cannot read is refused too.
import { describe, expect, it } from 'vitest'
import { gateRoute, parseMagpieRouting, readMagpieRouting, routeReach, type MagpieRouting } from '../src/main/route/remote-gate'

const PROVIDERS = {
  providers: [
    { id: 'deepseek', preset: 'deepseek', fallback: [] },
    { id: 'ollama', preset: 'ollama', fallback: ['solis/claude-opus-5-5'] },
    { id: 'solis', preset: 'remote-magpie', anthropic: 'http://127.0.0.1:13425' },
    { id: 'openai' }
  ],
  groups: [
    { id: 'smart', members: ['claude/claude-fable-5-2', 'deepseek/deepseek-flash'] },
    { id: 'mixed', members: ['deepseek/deepseek-flash', 'solis/claude-opus-5-5'] },
    { id: 'parked', members: ['deepseek/deepseek-flash', 'solis/claude-opus-5-5'], off: ['solis/claude-opus-5-5'] },
    { id: 'nested', members: ['group/mixed'] },
    { id: 'loop-a', members: ['group/loop-b'] },
    { id: 'loop-b', members: ['group/loop-a'] },
    { id: 'falls', members: ['ollama/qwen3:4b'] }
  ]
}

const routing = (raw: unknown = PROVIDERS): MagpieRouting => {
  const parsed = parseMagpieRouting(JSON.stringify(raw))
  if (parsed === null) throw new Error('fixture did not parse')
  return parsed
}

describe('routeReach: can this route land on another computer’s Magpie', () => {
  it('reads a remote provider’s own models and groups as remote', () => {
    expect(routeReach('solis/claude-opus-5-5', routing())).toBe('remote')
    expect(routeReach('solis/group/auto', routing())).toBe('remote')
  })

  it('reads a provider of this computer as local, plugin providers included', () => {
    expect(routeReach('deepseek/deepseek-flash', routing())).toBe('local')
    expect(routeReach('claude/claude-fable-5-2', routing())).toBe('local')
    expect(routeReach('direct', routing())).toBe('local')
  })

  it('follows groups, skipping members the group has turned off', () => {
    expect(routeReach('group/smart', routing())).toBe('local')
    expect(routeReach('group/mixed', routing())).toBe('remote')
    expect(routeReach('group/parked', routing())).toBe('local')
    expect(routeReach('group/nested', routing())).toBe('remote')
  })

  it('follows a provider’s fallback, directly and through a group', () => {
    expect(routeReach('ollama/qwen3:4b', routing())).toBe('remote')
    expect(routeReach('group/falls', routing())).toBe('remote')
  })

  it('cannot tell for a loop or a group it does not know while a remote exists', () => {
    expect(routeReach('group/loop-a', routing())).toBe('unknown')
    expect(routeReach('group/auto', routing())).toBe('unknown')
  })

  it('knows nothing is remote when no remote Magpie is set up', () => {
    const none = routing({ providers: [{ id: 'deepseek', preset: 'deepseek' }], groups: [] })
    expect(routeReach('group/auto', none)).toBe('local')
    expect(routeReach('solis/claude-opus-5-5', none)).toBe('local')
  })

  it('cannot tell anything when Magpie’s list could not be read', () => {
    expect(routeReach('deepseek/deepseek-flash', null)).toBe('unknown')
    expect(routeReach('direct', null)).toBe('local')
  })
})

describe('parseMagpieRouting / readMagpieRouting', () => {
  it('treats a missing list as an empty one and a broken list as unreadable', () => {
    const missing = (): string => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    }
    const denied = (): string => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' })
    }
    const env = { home: '/h', env: {} }
    expect(readMagpieRouting(env, missing)).toEqual({ remote: [], groups: {}, fallback: {} })
    expect(readMagpieRouting(env, denied)).toBeNull()
    expect(readMagpieRouting(env, () => '{not json')).toBeNull()
    expect(readMagpieRouting(env, () => '[]')).toBeNull()
    expect(readMagpieRouting(env, () => '{"providers":"x"}')).toBeNull()
  })

  it('never keeps a provider’s key', () => {
    const parsed = routing({ providers: [{ id: 'solis', preset: 'remote-magpie', key: 'sk-magpie-secretsecretsecret' }] })
    expect(JSON.stringify(parsed)).not.toContain('sk-magpie')
  })
})

describe('gateRoute: both switches, every time', () => {
  const on = { magpie: true, magpieRemote: true }
  const localOnly = { magpie: true, magpieRemote: false }

  it('always lets a card run direct', () => {
    expect(gateRoute('direct', null, null)).toEqual({ ok: true })
  })

  it('refuses everything when the switches cannot be read or Magpie is off', () => {
    expect(gateRoute('deepseek/deepseek-flash', null, routing())).toMatchObject({ ok: false })
    expect(gateRoute('deepseek/deepseek-flash', { magpie: false, magpieRemote: true }, routing())).toMatchObject({ ok: false })
  })

  it('refuses a remote or unknown route while remote is off, including groups and fallbacks', () => {
    for (const route of ['solis/claude-opus-5-5', 'group/mixed', 'group/nested', 'ollama/qwen3:4b', 'group/auto', 'group/loop-a']) {
      expect(gateRoute(route, localOnly, routing())).toMatchObject({ ok: false })
    }
    expect(gateRoute('deepseek/deepseek-flash', localOnly, null)).toMatchObject({ ok: false })
  })

  it('lets a local route through with remote off, and a remote one with both on', () => {
    expect(gateRoute('deepseek/deepseek-flash', localOnly, routing())).toEqual({ ok: true })
    expect(gateRoute('group/parked', localOnly, routing())).toEqual({ ok: true })
    expect(gateRoute('solis/claude-opus-5-5', on, routing())).toEqual({ ok: true })
    expect(gateRoute('group/auto', on, routing())).toEqual({ ok: true })
  })
})
