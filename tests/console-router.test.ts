import { describe, expect, it } from 'vitest'
import { createConsoleRouter, routeOfZoom, zoomOfRoute, type HistoryPort } from '../src/renderer/src/console/console-router'
import type { ConsoleRoute } from '../src/renderer/src/console/console-route'
import { readConsoleConfig } from '../src/renderer/src/console/console-config'

/**
 * THE ADDRESS FOLLOWS THE LEVEL (0.6.0). The console keeps the address bar in
 * step with where the view stands, so a refresh or a shared link lands there.
 * It does this by REPLACING the entry it is on: back is already "one step
 * out" on a web page (prompt/back-guard.ts keeps the one entry that makes it
 * so), and a second thing pushing entries would make back skip or repeat.
 */

const M = '11111111-1111-4111-8111-111111111111'
const W = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const A = 'a1b2c3d4-0000-4000-8000-000000000001'

const page = (at: string): HistoryPort & { url: () => string; pops: (() => void)[]; pushes: number; state: unknown } => {
  let url = new URL(at, 'https://console.cookrew.dev')
  const port = {
    state: { cookrewBack: 3 } as unknown,
    pushes: 0,
    pops: [] as (() => void)[],
    url: () => url.pathname + url.search,
    location: () => ({ pathname: url.pathname, search: url.search }),
    replace: (state: unknown, path: string) => {
      port.state = state
      url = new URL(path, 'https://console.cookrew.dev')
    },
    onPop: (listener: () => void) => {
      port.pops.push(listener)
      return () => undefined
    },
    moveTo: (path: string) => {
      url = new URL(path, 'https://console.cookrew.dev')
      port.pops.forEach((pop) => pop())
    }
  }
  return port as never
}

describe('the router', () => {
  it('starts on the level the address names', () => {
    expect(createConsoleRouter(page(`/d/${M}/w/${W}`)).get()).toEqual({ kind: 'machine', machine: M, workspace: W, agent: null, side: 'agents' })
    expect(createConsoleRouter(page('/')).get()).toEqual({ kind: 'devices' })
  })

  it('writes the level into the address by replacing the entry, and keeps whatever state that entry carried', () => {
    const at = page('/')
    const router = createConsoleRouter(at)
    const heard: ConsoleRoute[] = []
    router.subscribe(() => heard.push(router.get()))
    router.go({ kind: 'machine', machine: M, workspace: null, agent: null, side: 'agents' })
    expect(at.url()).toBe(`/d/${M}`)
    expect(at.state).toEqual({ cookrewBack: 3 })
    expect(heard).toHaveLength(1)
    // The same place again is no change and no write.
    router.go({ kind: 'machine', machine: M, workspace: null, agent: null, side: 'agents' })
    expect(heard).toHaveLength(1)
  })

  it('a pop does not move the level: the entry landed on is rewritten to where the view stands', () => {
    // Every pop on this page is the back guard's own entry coming off (prompt/back-guard.ts). The
    // entry under it still carries the address it had when the guard's was pushed, which may be a
    // level the view has since left: adopted, it would walk the person back into a machine.
    const at = page(`/d/${M}`)
    const router = createConsoleRouter(at)
    router.go({ kind: 'devices' })
    const heard: string[] = []
    router.subscribe(() => heard.push(router.get().kind))
    ;(at as unknown as { moveTo: (path: string) => void }).moveTo(`/d/${M}/w/${W}`)
    expect(router.get()).toEqual({ kind: 'devices' })
    expect(heard).toEqual([])
    expect(at.url()).toBe('/')
  })

  it('takes the code off the address the moment it is read', () => {
    const at = page('/auth/complete?code=secret-code&state=xyz')
    const router = createConsoleRouter(at)
    const back = router.get()
    expect(back).toEqual({ kind: 'auth-complete', code: 'secret-code', state: 'xyz', error: null })
    expect(at.url()).toBe('/')
    expect(at.url()).not.toContain('secret-code')
  })
})

describe('the level a view stands at, as an address', () => {
  const at = (dir: 'agents' | 'items', v: number, agent: string | null = null): { dir: 'agents' | 'items'; v: number; agent: string | null } => ({ dir, v, agent })

  it('the device stop is the machine; the crew is its workspace; a card is its agent', () => {
    expect(routeOfZoom(at('agents', -1), M, W)).toEqual({ kind: 'machine', machine: M, workspace: null, agent: null, side: 'agents' })
    expect(routeOfZoom(at('agents', 1), M, W)).toEqual({ kind: 'machine', machine: M, workspace: W, agent: null, side: 'agents' })
    expect(routeOfZoom(at('agents', 2, A), M, W)).toEqual({ kind: 'machine', machine: M, workspace: W, agent: A, side: 'agents' })
    // A full view is the card it opened from: a refresh comes back to the card.
    expect(routeOfZoom(at('agents', 3, A), M, W)).toEqual({ kind: 'machine', machine: M, workspace: W, agent: A, side: 'agents' })
  })

  it('the artifacts side is the same workspace, by its other side', () => {
    expect(routeOfZoom(at('items', 0), M, W)).toEqual({ kind: 'machine', machine: M, workspace: W, agent: null, side: 'items' })
    expect(routeOfZoom(at('items', 1), M, W)).toEqual({ kind: 'machine', machine: M, workspace: W, agent: null, side: 'items' })
  })

  it('the devices stop is not a level of a machine: it is the way out of it', () => {
    expect(routeOfZoom(at('agents', -2), M, W)).toEqual({ kind: 'devices' })
    expect(routeOfZoom(at('items', -2), M, W)).toEqual({ kind: 'devices' })
  })

  it('on the way between two stops it is the stop it is nearer to, never an address of its own', () => {
    expect(routeOfZoom(at('agents', -0.2), M, W).kind === 'machine' && routeOfZoom(at('agents', -0.2), M, W)).toMatchObject({ workspace: null })
    expect(routeOfZoom(at('agents', 0.6), M, W)).toMatchObject({ workspace: W, agent: null })
    // On its way out it has not left: the machine is left on arrival at the devices stop.
    expect(routeOfZoom(at('agents', -1.6), M, W)).toMatchObject({ kind: 'machine', workspace: null })
  })

  it('names no workspace before it knows which one the view is on, and no card without an agent in focus', () => {
    expect(routeOfZoom(at('agents', 1), M, null)).toEqual({ kind: 'machine', machine: M, workspace: null, agent: null, side: 'agents' })
    expect(routeOfZoom(at('agents', 2, null), M, W)).toMatchObject({ workspace: W, agent: null })
  })

  it('and back: where the view goes for an address', () => {
    expect(zoomOfRoute({ kind: 'machine', machine: M, workspace: null, agent: null, side: 'agents' })).toEqual({ dir: 'agents', v: -1, agent: null })
    expect(zoomOfRoute({ kind: 'machine', machine: M, workspace: W, agent: null, side: 'agents' })).toEqual({ dir: 'agents', v: 1, agent: null })
    expect(zoomOfRoute({ kind: 'machine', machine: M, workspace: W, agent: null, side: 'items' })).toEqual({ dir: 'items', v: 0, agent: null })
    expect(zoomOfRoute({ kind: 'machine', machine: M, workspace: W, agent: A, side: 'agents' })).toEqual({ dir: 'agents', v: 2, agent: A })
  })
})

describe('what the page was built for', () => {
  const doc = (metas: Record<string, string>): Pick<Document, 'querySelector'> =>
    ({ querySelector: (selector: string) => {
      const name = /name="([^"]+)"/.exec(selector)?.[1] ?? ''
      return name in metas ? ({ getAttribute: () => metas[name] } as unknown as Element) : null
    } }) as never

  it('reads the registry’s two hosts from the page itself', () => {
    expect(readConsoleConfig(doc({ 'cookrew-mode': 'console', 'cookrew-api': 'https://api.cookrew.dev', 'cookrew-auth': 'https://auth.cookrew.dev' }))).toEqual({
      apiOrigin: 'https://api.cookrew.dev',
      authOrigin: 'https://auth.cookrew.dev'
    })
    expect(readConsoleConfig(doc({ 'cookrew-mode': 'console', 'cookrew-api': 'http://api.localhost:8700/', 'cookrew-auth': 'http://auth.localhost:8700' }))).toEqual({
      apiOrigin: 'http://api.localhost:8700',
      authOrigin: 'http://auth.localhost:8700'
    })
  })

  it('is not the console without the mark, and not with a host that is not an origin', () => {
    expect(readConsoleConfig(doc({ 'cookrew-api': 'https://api.cookrew.dev', 'cookrew-auth': 'https://auth.cookrew.dev' }))).toBeNull()
    expect(readConsoleConfig(doc({ 'cookrew-mode': 'console', 'cookrew-api': 'javascript:alert(1)', 'cookrew-auth': 'https://auth.cookrew.dev' }))).toBeNull()
    expect(readConsoleConfig(doc({ 'cookrew-mode': 'console', 'cookrew-api': 'https://api.cookrew.dev/path', 'cookrew-auth': 'https://auth.cookrew.dev' }))).toBeNull()
    expect(readConsoleConfig(doc({ 'cookrew-mode': 'console', 'cookrew-api': 'http://api.cookrew.dev', 'cookrew-auth': 'https://auth.cookrew.dev' }))).toBeNull()
    expect(readConsoleConfig(doc({ 'cookrew-mode': 'console' }))).toBeNull()
  })
})
