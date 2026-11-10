import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCOPE_PHASES,
  configureMachineScope,
  enterMachine,
  machineBaseOf,
  machineScope,
  registerScopeState,
  relayHeadersFor,
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
