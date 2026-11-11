import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCOPE_PHASES,
  configureMachineScope,
  enterMachine,
  heldScope,
  machineBaseOf,
  machineLeft,
  machineScope,
  registerScopeState,
  relayFetch,
  relayHeadersFor,
  relayHeadersForUrl,
  relayRequestFor,
  resetMachineScopeForTests,
  scopeBase,
  scopeEpoch,
  scopeNeedsMachine,
  scopeStates,
  subscribeMachineScope
} from '../src/renderer/src/machine-scope'

/**
 * ONE PAGE, SEVERAL MACHINES, ONE AT A TIME (0.6.0).
 *
 * The console is one document for every machine of the account. What the page
 * is talking to is the machine in scope; entering another one is not a reload,
 * so everything the page held for the one it leaves has to be let go here, by
 * name, or machine A's cards would be drawn over machine B.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const API = 'https://api.cookrew.dev'

beforeEach(() => {
  resetMachineScopeForTests()
})

describe('the page a machine serves itself', () => {
  it('has no machine to name and no relay: it talks to whoever served it', () => {
    expect(machineScope()).toEqual({ machineId: null, relay: null, slug: '' })
    expect(scopeBase()).toBe('')
    expect(relayHeadersFor()).toEqual({})
    expect(scopeNeedsMachine()).toBe(false)
    expect(machineBaseOf(A)).toBeNull()
  })
})

describe('the console', () => {
  let session: string | null = 'session-one'
  beforeEach(() => {
    session = 'session-one'
    configureMachineScope({ relay: { origin: `${API}/`, session: () => session } })
  })

  it('reaches a machine at the one relay path, by its id, on the API host', () => {
    expect(scopeNeedsMachine()).toBe(true)
    expect(scopeBase()).toBe('')
    enterMachine(A)
    expect(machineScope().machineId).toBe(A)
    expect(scopeBase()).toBe(`${API}/api/m/${A}`)
    expect(machineBaseOf(B)).toBe(`${API}/api/m/${B}`)
    expect(machineBaseOf(B.toUpperCase())).toBe(`${API}/api/m/${B}`)
  })

  it('refuses an id that is not a machine’s: nothing typed into an address becomes a path', () => {
    for (const bad of ['', 'nope', '../x', `${A}/..`, `${A}?x=1`, 'a'.repeat(36)]) {
      expect(machineBaseOf(bad), bad).toBeNull()
      expect(() => enterMachine(bad), bad).toThrow()
    }
    expect(machineScope().machineId).toBeNull()
  })

  it('sends the account session to the relay in its own header, read at each request', () => {
    expect(relayHeadersFor()).toEqual({ 'x-cookrew-session': 'session-one' })
    session = 'session-two'
    expect(relayHeadersFor()).toEqual({ 'x-cookrew-session': 'session-two' })
    session = null
    expect(relayHeadersFor()).toEqual({})
  })

  it('leaves every machine by entering none', () => {
    enterMachine(A)
    enterMachine(null)
    expect(machineScope().machineId).toBeNull()
    expect(scopeBase()).toBe('')
  })
})

describe('entering another machine', () => {
  beforeEach(() => {
    configureMachineScope({ relay: { origin: API, session: () => 's' } })
  })

  it('lets go of everything held for the one it leaves, before the new one is in scope', () => {
    const seen: string[] = []
    registerScopeState('a store', () => seen.push(`store saw ${machineScope().machineId}`))
    registerScopeState('a stream', () => seen.push(`stream saw ${machineScope().machineId}`), 'stop')
    enterMachine(A)
    seen.length = 0
    enterMachine(B)
    // What talks is stopped before what holds is cleared, and both while the old machine is still the one in scope.
    expect(seen).toEqual([`stream saw ${A}`, `store saw ${A}`])
    expect(machineScope().machineId).toBe(B)
  })

  it('does nothing when it is the machine already in scope', () => {
    const reset = vi.fn()
    registerScopeState('a store', reset)
    enterMachine(A)
    const epoch = scopeEpoch()
    reset.mockClear()
    enterMachine(A)
    enterMachine(A.toUpperCase())
    expect(reset).not.toHaveBeenCalled()
    expect(scopeEpoch()).toBe(epoch)
  })

  it('counts each change, so a view can be remounted for the machine it now shows', () => {
    const heard: (string | null)[] = []
    const stop = subscribeMachineScope((scope) => heard.push(scope.machineId))
    const before = scopeEpoch()
    enterMachine(A)
    enterMachine(B)
    enterMachine(null)
    expect(scopeEpoch()).toBe(before + 3)
    expect(heard).toEqual([A, B, null])
    stop()
    enterMachine(A)
    expect(heard).toHaveLength(3)
  })

  it('still changes machine when one state fails to let go, and lets go of the rest', () => {
    const later = vi.fn()
    registerScopeState('broken', () => {
      throw new Error('boom')
    })
    registerScopeState('after it', later)
    enterMachine(A)
    later.mockClear()
    expect(() => enterMachine(B)).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
    expect(machineScope().machineId).toBe(B)
  })

  it('knows each state by one name, so a second registration replaces the first rather than doubling it', () => {
    const first = vi.fn()
    const second = vi.fn()
    registerScopeState('same name', first)
    registerScopeState('same name', second)
    enterMachine(A)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(scopeStates().filter((name) => name === 'same name')).toHaveLength(1)
  })

  it('has two phases and no other', () => {
    expect(SCOPE_PHASES).toEqual(['stop', 'clear'])
  })
})

describe('work that waits while the machine changes', () => {
  const console_ = (): void => configureMachineScope({ relay: { origin: API, session: () => 'account-session' } })

  it('holds for as long as the machine it was started for is in scope, and never again after', () => {
    console_()
    enterMachine(A)
    const stillA = heldScope()
    expect(stillA()).toBe(true)
    enterMachine(B)
    expect(stillA()).toBe(false)
    // Back on A is another visit: what waited since the first one is not owed an answer.
    enterMachine(A)
    expect(stillA()).toBe(false)
    expect(heldScope()()).toBe(true)
  })

  it('ends as an abort, which nothing counts against the path', () => {
    expect(machineLeft().name).toBe('AbortError')
  })
})

describe('the account session, judged by where a request goes', () => {
  const session = { 'x-cookrew-session': 'account-session' }
  beforeEach(() => {
    configureMachineScope({ relay: { origin: `${API}/`, session: () => 'account-session' } })
    enterMachine(A)
  })

  it('rides a URL under the relay’s machine prefix, for any machine of the account', () => {
    expect(relayHeadersForUrl(`${API}/api/m/${A}/api/workspaces`)).toEqual(session)
    expect(relayHeadersForUrl(`${API}/api/m/${B}/api/fleet`)).toEqual(session)
  })

  it('never rides anything else: a direct name, a look-alike host, another path of the API host, a relative path', () => {
    for (const url of [
      `https://192-168-1-7.${A}.d.cookrew.dev:8643/api/workspaces`,
      `${API}.evil.example/api/m/${A}/api/workspaces`,
      `https://evil.example/?${API}/api/m/${A}/`,
      `${API}/v2/me/desktops`,
      `${API}/api/mx/${A}/api/workspaces`,
      '/api/workspaces'
    ]) {
      expect(relayHeadersForUrl(url), url).toEqual({})
    }
  })

  it('is nothing on a page a machine serves itself', () => {
    resetMachineScopeForTests()
    expect(relayHeadersForUrl(`${API}/api/m/${A}/api/workspaces`)).toEqual({})
  })
})

describe('a relayed call as it leaves the page: one address, one preflight (latency 0.6.1)', () => {
  beforeEach(() => {
    configureMachineScope({ relay: { origin: `${API}/`, session: () => 'account-session' } })
    enterMachine(A)
  })

  it('goes to the one address with the machine, the route and the session in headers', () => {
    expect(relayRequestFor(`${API}/api/m/${A}/api/terminal/t1/turns?after=5`, { authorization: 'Bearer machine-key' })).toEqual({
      url: `${API}/api/m`,
      headers: { authorization: 'Bearer machine-key', 'x-cookrew-session': 'account-session', 'x-cookrew-machine': A, 'x-cookrew-route': 'api/terminal/t1/turns?after=5' }
    })
  })

  it('sends every machine and every route to the same address', () => {
    const urls = [`${API}/api/m/${A}/api/fleet`, `${API}/api/m/${A}/api/events`, `${API}/api/m/${B}/api/watch/cards?workspace=w1`]
    expect(new Set(urls.map((url) => relayRequestFor(url, undefined).url))).toEqual(new Set([`${API}/api/m`]))
  })

  it('lets nothing a caller passed stand in for the session or name another machine', () => {
    const sent = relayRequestFor(`${API}/api/m/${A}/api/fleet`, { 'X-Cookrew-Session': 'forged', 'x-cookrew-machine': B, 'x-cookrew-route': 'api/secrets' })
    expect(sent.headers['x-cookrew-session']).toBe('account-session')
    expect(sent.headers['x-cookrew-machine']).toBe(A)
    expect(sent.headers['x-cookrew-route']).toBe('api/fleet')
  })

  it('leaves everything else as it was asked, with nothing added', () => {
    for (const url of [`https://192-168-1-7.${A}.d.cookrew.dev:8643/api/workspaces`, `${API}/v2/me/desktops`, '/api/workspaces']) {
      expect(relayRequestFor(url, { authorization: 'Bearer t' }), url).toEqual({ url, headers: { authorization: 'Bearer t' } })
    }
    resetMachineScopeForTests()
    expect(relayRequestFor(`${API}/api/m/${A}/api/fleet`, undefined)).toEqual({ url: `${API}/api/m/${A}/api/fleet`, headers: {} })
  })

  it('is what relayFetch sends', async () => {
    const sent: { input: string; init: RequestInit }[] = []
    const send = relayFetch(async (input, init) => {
      sent.push({ input, init })
      return new Response('{}')
    })
    await send(`${API}/api/m/${A}/api/fleet`, { method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: '{}' })
    expect(sent[0].input).toBe(`${API}/api/m`)
    expect(sent[0].init).toMatchObject({ method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-cookrew-route': 'api/fleet', 'x-cookrew-machine': A } })
  })
})

describe('saying the page is the console', () => {
  it('is a change like any other: what was held is let go of, and whoever follows the scope is told', () => {
    const order: string[] = []
    registerScopeState('a stream', () => order.push('stop'), 'stop')
    registerScopeState('a store', () => order.push('clear'))
    const heard: (string | null)[] = []
    subscribeMachineScope((next) => heard.push(next.relay?.origin ?? null))
    const before = scopeEpoch()
    configureMachineScope({ relay: { origin: API, session: () => null } })
    expect(order).toEqual(['stop', 'clear'])
    expect(heard).toEqual([API])
    expect(scopeEpoch()).toBe(before + 1)
    expect(scopeNeedsMachine()).toBe(true)
  })
})
