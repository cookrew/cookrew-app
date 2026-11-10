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
  it('stops what had started as if the page were a machine’s own, whenever the page says it is the console', async () => {
    const session = await import('../src/renderer/src/machine-session')
    // The boot's lines in the wrong order: the session first, the console said after.
    session.startMachineSession()
    expect(path).toEqual({ started: 1, stopped: 0 })
    await inConsole(null)
    expect(path).toEqual({ started: 1, stopped: 1 })
    expect(builds).toEqual({ watched: 1, stopped: 1 })
  })

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

describe('the console’s machine view (console/ConsoleMachine.tsx)', () => {
  // The view is the whole app; what is under test here is only what loading its chunk starts.
  // Named in a variable: this file is typechecked with the main process's sources, which must not
  // be made to follow the import into the app's own components (they are the web project's).
  const VIEW = '../src/renderer/src/console/ConsoleMachine'
  const loadView = async (): Promise<unknown> => {
    vi.doMock('../src/renderer/src/App', () => ({ default: () => null }))
    try {
      return await import(/* @vite-ignore */ VIEW)
    } finally {
      vi.doUnmock('../src/renderer/src/App')
    }
  }

  it('starts the session for a machine entered before its chunk arrived (a cold link straight into a machine)', async () => {
    const scope = await inConsole(A)
    await loadView()
    expect(path).toEqual({ started: 1, stopped: 0 })
    expect(builds.watched).toBe(0)
    scope.enterMachine(null)
    expect(path).toEqual({ started: 1, stopped: 1 })
  })

  it('loaded ahead of any machine it starts nothing, then starts once per machine entered and stops when it is left', async () => {
    const scope = await inConsole(null)
    await loadView()
    expect(path).toEqual({ started: 0, stopped: 0 })
    scope.enterMachine(A)
    expect(path).toEqual({ started: 1, stopped: 0 })
    scope.enterMachine(null)
    expect(path).toEqual({ started: 1, stopped: 1 })
    scope.enterMachine(B)
    expect(path).toEqual({ started: 2, stopped: 1 })
    expect(builds).toEqual({ watched: 0, stopped: 0 })
  })
})
