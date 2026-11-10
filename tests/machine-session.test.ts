import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'

/**
 * WHAT RUNS FOR ONE MACHINE STOPS WITH IT. The path switcher raced for one
 * machine for the life of the page, and the build watch reloaded the page when
 * "the Mac" served another build. On the console both are per machine in
 * scope: stopped when it is left, started for the next, and the build watch
 * not at all (the console is its own build).
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const path = { started: 0, stopped: 0 }
const builds = { watched: 0, stopped: 0 }

beforeEach(() => {
  vi.resetModules()
  path.started = path.stopped = builds.watched = builds.stopped = 0
  const page = bareWindow('https://console.cookrew.dev/')
  vi.stubGlobal('window', { ...page, COOKREW_MOBILE: 1 })
  vi.stubGlobal('localStorage', page.localStorage)
  vi.stubGlobal('document', { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
  vi.doMock('../src/renderer/src/path/companion', () => ({
    startCompanionPathSwitch: () => {
      path.started += 1
      return () => void (path.stopped += 1)
    }
  }))
  vi.doMock('../src/renderer/src/build-watch', () => ({
    watchBuild: () => {
      builds.watched += 1
      return () => void (builds.stopped += 1)
    }
  }))
})

afterEach(() => {
  vi.doUnmock('../src/renderer/src/path/companion')
  vi.doUnmock('../src/renderer/src/build-watch')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('on a machine’s own page', () => {
  it('starts once, with the build watch: the page is that machine’s build', async () => {
    const session = await import('../src/renderer/src/machine-session')
    session.startMachineSession()
    expect(path).toEqual({ started: 1, stopped: 0 })
    expect(builds).toEqual({ watched: 1, stopped: 0 })
  })
})

describe('on the console', () => {
  it('runs nothing until a machine is entered', async () => {
    await inConsole(null)
    const session = await import('../src/renderer/src/machine-session')
    session.startMachineSession()
    expect(path.started).toBe(0)
    expect(builds.watched).toBe(0)
  })

  it('stops the last machine’s path switcher before the next one’s starts, and never watches a machine’s build', async () => {
    const scope = await inConsole(A)
    const session = await import('../src/renderer/src/machine-session')
    session.startMachineSession()
    expect(path).toEqual({ started: 1, stopped: 0 })
    const order: string[] = []
    scope.registerScopeState('a store, to see the order', () => order.push(`cleared after ${path.stopped} stop`))
    scope.enterMachine(B)
    expect(path).toEqual({ started: 2, stopped: 1 })
    expect(order).toEqual(['cleared after 1 stop'])
    scope.enterMachine(null)
    expect(path).toEqual({ started: 2, stopped: 2 })
    scope.enterMachine(A)
    expect(path).toEqual({ started: 3, stopped: 2 })
    expect(builds).toEqual({ watched: 0, stopped: 0 })
  })
})
