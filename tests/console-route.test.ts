import { describe, expect, it } from 'vitest'
import { parseConsoleRoute, consoleRoutePath, routeOut, sameRoute, type ConsoleRoute } from '../src/renderer/src/console/console-route'

/**
 * THE CONSOLE'S ADDRESS IS WHERE YOU ARE (0.6.0). One page, four shapes:
 *
 *   /                              the account's machines
 *   /d/<machine>                   that machine's workspaces
 *   /d/<machine>/w/<ws>            that workspace's agents (or, ?side=items, its artifacts)
 *   /d/<machine>/w/<ws>/a/<agent>  that agent's card
 *
 * and /auth/complete, where the sign-in page hands back. A refresh, a shared
 * link and the back key all land on the level the address names.
 */

const M = '11111111-1111-4111-8111-111111111111'
const W = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const A = 'a1b2c3d4-0000-4000-8000-000000000001'

const machine = (over: Partial<Extract<ConsoleRoute, { kind: 'machine' }>> = {}): ConsoleRoute => ({ kind: 'machine', machine: M, workspace: null, agent: null, side: 'agents', ...over })

describe('reading an address', () => {
  it('the root is the machines', () => {
    expect(parseConsoleRoute('/')).toEqual({ kind: 'devices' })
    expect(parseConsoleRoute('')).toEqual({ kind: 'devices' })
  })

  it('reads each level', () => {
    expect(parseConsoleRoute(`/d/${M}`)).toEqual(machine())
    expect(parseConsoleRoute(`/d/${M}/`)).toEqual(machine())
    expect(parseConsoleRoute(`/d/${M}/w/${W}`)).toEqual(machine({ workspace: W }))
    expect(parseConsoleRoute(`/d/${M}/w/${W}/a/${A}`)).toEqual(machine({ workspace: W, agent: A }))
  })

  it('reads the artifacts side of a workspace, and only there', () => {
    expect(parseConsoleRoute(`/d/${M}/w/${W}`, '?side=items')).toEqual(machine({ workspace: W, side: 'items' }))
    expect(parseConsoleRoute(`/d/${M}/w/${W}`, '?side=whatever')).toEqual(machine({ workspace: W }))
    expect(parseConsoleRoute(`/d/${M}/w/${W}/a/${A}`, '?side=items')).toEqual(machine({ workspace: W, agent: A }))
    expect(parseConsoleRoute(`/d/${M}`, '?side=items')).toEqual(machine())
  })

  it('lowercases a machine id, so one machine has one address', () => {
    expect(parseConsoleRoute(`/d/${M.toUpperCase()}`)).toEqual(machine())
  })

  it('reads where the sign-in page hands back, with whatever it brought', () => {
    expect(parseConsoleRoute('/auth/complete', '?code=abc&state=xyz')).toEqual({ kind: 'auth-complete', code: 'abc', state: 'xyz', error: null })
    expect(parseConsoleRoute('/auth/complete', '?error=cancelled&state=xyz')).toEqual({ kind: 'auth-complete', code: null, state: 'xyz', error: 'cancelled' })
    expect(parseConsoleRoute('/auth/complete')).toEqual({ kind: 'auth-complete', code: null, state: null, error: null })
  })

  it('anything it cannot read is the machines: a static host answers every path with this page', () => {
    for (const path of [
      '/me',
      '/d',
      '/d/not-a-machine',
      `/d/${M}/x`,
      `/d/${M}/w`,
      `/d/${M}/w/${W}/a`,
      `/d/${M}/w/${W}/b/${A}`,
      `/d/${M}/w/${W}/a/${A}/more`,
      `/d/${M}/w/has space`,
      `/d/${M}/w/..%2f..`,
      `/d/${M}/w/${'x'.repeat(65)}`,
      '/relay/@drej/desktop/' + M
    ]) {
      expect(parseConsoleRoute(path), path).toEqual({ kind: 'devices' })
    }
  })
})

describe('writing an address', () => {
  it('is the inverse of reading it', () => {
    const routes: ConsoleRoute[] = [{ kind: 'devices' }, machine(), machine({ workspace: W }), machine({ workspace: W, side: 'items' }), machine({ workspace: W, agent: A })]
    for (const route of routes) {
      const url = new URL(consoleRoutePath(route), 'https://console.cookrew.dev')
      expect(parseConsoleRoute(url.pathname, url.search), consoleRoutePath(route)).toEqual(route)
    }
    expect(consoleRoutePath({ kind: 'devices' })).toBe('/')
    expect(consoleRoutePath(machine({ workspace: W, agent: A }))).toBe(`/d/${M}/w/${W}/a/${A}`)
    expect(consoleRoutePath(machine({ workspace: W, side: 'items' }))).toBe(`/d/${M}/w/${W}?side=items`)
  })

  it('never writes a credential: the way back from sign-in is not an address the page goes to', () => {
    expect(consoleRoutePath({ kind: 'auth-complete', code: 'abc', state: 'xyz', error: null })).toBe('/')
  })

  it('an agent with no workspace named is the machine: a card is in a workspace', () => {
    expect(consoleRoutePath(machine({ agent: A }))).toBe(`/d/${M}`)
  })
})

describe('one level out', () => {
  it('goes card, agents, workspaces, machines, and stays there', () => {
    const card = machine({ workspace: W, agent: A })
    const agents = routeOut(card)
    expect(agents).toEqual(machine({ workspace: W }))
    const workspaces = routeOut(agents)
    expect(workspaces).toEqual(machine())
    expect(routeOut(workspaces)).toEqual({ kind: 'devices' })
    expect(routeOut({ kind: 'devices' })).toEqual({ kind: 'devices' })
  })

  it('knows two routes for one place', () => {
    expect(sameRoute(machine({ workspace: W }), machine({ workspace: W }))).toBe(true)
    expect(sameRoute(machine({ workspace: W }), machine({ workspace: W, side: 'items' }))).toBe(false)
    expect(sameRoute({ kind: 'devices' }, machine())).toBe(false)
  })
})
