import { describe, expect, it } from 'vitest'
import { accountKnowledge, accountStarting, accountVia, defaultChoices, guideVisible, needsDefault, subscriptionLines, type AccountRoute } from '../src/shared/ai-account'
import type { HarnessRow, RouteModel } from '../src/shared/route'

const harness = (id: HarnessRow['id'], installed: boolean, signedIn: boolean | null): HarnessRow => ({
  id,
  name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : id,
  installed,
  signedIn,
  inDock: false,
  installLine: '',
  loginLine: id === 'claude' ? 'claude' : id === 'codex' ? 'codex login' : null,
  routable: true
})

const model = (id: string): RouteModel => ({ id, displayName: id, ownedBy: 'x', group: id.startsWith('group/'), reasoning: false, levels: [], contextWindow: null })

const route = (over: Partial<AccountRoute> = {}): AccountRoute => ({
  status: 'absent',
  defaultModel: null,
  models: [],
  harnesses: [harness('claude', true, false), harness('codex', true, false)],
  ...over
})

describe('accountVia: is there any account an agent can run on?', () => {
  it('is nothing on a computer with tools but no sign-in', () => {
    expect(accountVia({ route: route(), endpoint: false })).toBeNull()
  })

  it('counts a signed-in Claude Code or Codex', () => {
    expect(accountVia({ route: route({ harnesses: [harness('claude', true, true)] }), endpoint: false })).toBe('claude')
    expect(accountVia({ route: route({ harnesses: [harness('codex', true, true)] }), endpoint: false })).toBe('codex')
  })

  it('does not count a sign-in file left by a tool that is gone', () => {
    expect(accountVia({ route: route({ harnesses: [harness('claude', false, true)] }), endpoint: false })).toBeNull()
  })

  it('counts the person’s own endpoint', () => {
    expect(accountVia({ route: null, endpoint: true })).toBe('endpoint')
  })

  it('counts Magpie only when it runs and new cards have a default model to go to', () => {
    expect(accountVia({ route: route({ status: 'online', models: [model('deepseek/chat')] }), endpoint: false })).toBeNull()
    expect(accountVia({ route: route({ status: 'offline', defaultModel: 'deepseek/chat' }), endpoint: false })).toBeNull()
    expect(accountVia({ route: route({ status: 'online', defaultModel: 'mac/group/smart' }), endpoint: false })).toBe('magpie')
  })
})

describe('account knowledge', () => {
  it('does not claim no account when the default or inventory is withheld', () => {
    const hiddenDefault = route({ status: 'online', models: [model('a/b')], withheld: { defaultModel: true } })
    const hiddenCatalog = route({ status: 'online', withheld: { endpointInventory: true } })
    expect(accountKnowledge({ route: hiddenDefault, endpoint: false })).toEqual({ via: null, known: false })
    expect(accountKnowledge({ route: hiddenCatalog, endpoint: false })).toEqual({ via: null, known: false })
    expect(accountKnowledge({ route: hiddenDefault, endpoint: true })).toEqual({ via: 'endpoint', known: true })
    expect(needsDefault(hiddenDefault)).toBe(false)
    expect(accountKnowledge({ route: route(), endpoint: false })).toEqual({ via: null, known: true })
    expect(accountKnowledge({ route: null, endpoint: false })).toEqual({ via: null, known: false })
  })
})

describe('needsDefault', () => {
  it('asks for a default once Magpie has a model and none is picked', () => {
    expect(needsDefault(route({ status: 'online', models: [model('mac/claude-opus')] }))).toBe(true)
    expect(needsDefault(route({ status: 'online', models: [model('mac/claude-opus')], defaultModel: 'mac/claude-opus' }))).toBe(false)
    expect(needsDefault(route({ status: 'online' }))).toBe(false)
    expect(needsDefault(route({ status: 'offline', models: [model('a/b')] }))).toBe(false)
    expect(needsDefault(null)).toBe(false)
  })

  it('offers routing groups first, then models', () => {
    const ids = defaultChoices([model('a/x'), model('group/smart'), model('mac/group/fast'), model('b/y')]).map((m) => m.id)
    expect(ids).toEqual(['group/smart', 'mac/group/fast', 'a/x', 'b/y'])
  })
})

describe('subscriptionLines', () => {
  it('signs a subscription in to Magpie when Magpie is here', () => {
    expect(subscriptionLines(route({ status: 'offline' })).map((s) => s.line)).toEqual(['magpie accounts add claude', 'magpie accounts add codex'])
  })

  it('falls back to each tool’s own sign-in without Magpie', () => {
    expect(subscriptionLines(route()).map((s) => s.line)).toEqual(['claude', 'codex login'])
    expect(subscriptionLines(route({ harnesses: [harness('codex', true, false)] })).map((s) => s.line)).toEqual(['codex login'])
    expect(subscriptionLines(route({ harnesses: [] }))).toEqual([])
    expect(subscriptionLines(null)).toEqual([])
  })
})

describe('guideVisible: the launch nudge', () => {
  const base = { stage: 'closed' as const, via: null, settled: true, dismissed: false }
  it('shows after the first run, once the facts have settled, with no account', () => {
    expect(guideVisible(base)).toBe(true)
  })
  it('stays out of the first run, an unsettled read, a dismissal and a working account', () => {
    expect(guideVisible({ ...base, stage: 'preflight' })).toBe(false)
    expect(guideVisible({ ...base, stage: 'second' })).toBe(true)
    expect(guideVisible({ ...base, settled: false })).toBe(false)
    expect(guideVisible({ ...base, dismissed: true })).toBe(false)
    expect(guideVisible({ ...base, via: 'claude' })).toBe(false)
  })
})

describe('accountStarting', () => {
  it('reads a stopped Magpie with a default as starting, not as no account', () => {
    expect(accountStarting(route({ status: 'offline', defaultModel: 'group/smart' }))).toBe(true)
    expect(accountStarting(route({ status: 'offline' }))).toBe(false)
    expect(accountStarting(route({ status: 'online', defaultModel: 'group/smart' }))).toBe(false)
    expect(accountStarting(null)).toBe(false)
  })
})
