import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { inConsole, relayBaseFor } from './support/console-scope'

/**
 * THE API OBJECT, ACROSS A CHANGE OF MACHINE.
 *
 * The remote api kept everything for "the machine" in module-level variables:
 * the event stream, reads in flight, keystrokes not yet typed, the pairing
 * token. On the console those are one machine's and must not outlive it:
 * each case here puts something in for machine A, enters machine B, and
 * looks for it.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const BASE_A = relayBaseFor(A)
const BASE_B = relayBaseFor(B)

interface Sent {
  url: string
  init: RequestInit
  answer: (response: Response) => void
  fail: (error: unknown) => void
}

let sent: Sent[] = []
const to = (base: string, path: string): Sent[] => sent.filter((one) => one.url.startsWith(`${base}${path}`))
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Scope = typeof import('../src/renderer/src/machine-scope')
type Api = typeof import('../src/renderer/src/api')

async function consoleAt(machineId: string | null): Promise<{ scope: Scope; api: Api }> {
  vi.resetModules()
  const scope = await inConsole(machineId)
  const api = await import('../src/renderer/src/api')
  return { scope, api }
}

beforeEach(() => {
  sent = []
  const page = bareWindow('https://console.cookrew.dev/')
  vi.stubGlobal('window', { ...page, COOKREW_MOBILE: 1 })
  vi.stubGlobal('localStorage', page.localStorage)
  vi.stubGlobal('document', { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit = {}) =>
        new Promise<Response>((answer, fail) => {
          sent.push({ url: String(url), init, answer, fail })
          init.signal?.addEventListener('abort', () => fail(init.signal?.reason ?? new DOMException('aborted', 'AbortError')), { once: true })
        })
    )
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the console with no machine in scope', () => {
  it('has an api, and asks no machine anything by making it', async () => {
    const { api } = await consoleAt(null)
    expect(api.isRemoteMode()).toBe(true)
    const remote = api.cookrew()
    await tick()
    expect(sent).toEqual([])
    // Asked of nobody is refused where it is asked, not sent to the console's own host.
    expect(() => remote.getWorkspace()).toThrow('no machine is in scope')
    expect(() => remote.onWorkspaceState(() => undefined)).toThrow('no machine is in scope')
    await tick()
    expect(sent).toEqual([])
  })
})

describe('entering another machine', () => {
  it('asks the new machine whether this browser is paired, at its own address', async () => {
    const { scope, api } = await consoleAt(A)
    api.cookrew()
    await tick()
    expect(sent.every((one) => one.url.startsWith(BASE_A))).toBe(true)
    const before = sent.length
    expect(before).toBeGreaterThan(0)
    scope.enterMachine(B)
    const next = api.cookrew()
    await tick()
    expect(sent.slice(before).length).toBeGreaterThan(0)
    expect(sent.slice(before).every((one) => one.url.startsWith(BASE_B))).toBe(true)
    // A new object: nothing made for the last machine is handed out for this one.
    scope.enterMachine(A)
    expect(api.cookrew()).not.toBe(next)
  })

  it('closes the last machine’s event stream, and opens the next one’s only when somebody listens', async () => {
    const { scope, api } = await consoleAt(A)
    const heard: string[] = []
    api.cookrew().onWorkspaceState((state) => heard.push(String((state as unknown as { id: string }).id)))
    await tick()
    const streamA = to(BASE_A, '/api/events')
    expect(streamA).toHaveLength(1)
    expect(streamA[0].url).toContain('boot=')
    expect(new Headers(streamA[0].init.headers).get('x-cookrew-session')).toBe('account-session')

    scope.enterMachine(B)
    // Closed, not left running beside the new one: its request is aborted.
    expect(streamA[0].init.signal?.aborted).toBe(true)
    await tick()
    expect(to(BASE_B, '/api/events')).toHaveLength(0)

    api.cookrew().onWorkspaceState(() => undefined)
    await tick()
    const streamB = to(BASE_B, '/api/events')
    expect(streamB).toHaveLength(1)
    // The new machine's stream is its first connect: it boots from the pull, as any first connect does.
    expect(streamB[0].url).toContain('boot=')
    // And machine A is not dialled again by anything left behind.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(to(BASE_A, '/api/events')).toHaveLength(1)
    expect(heard).toEqual([])
  })

  it('answers a reader of the next machine from the next machine, and ends a read of the last one unanswered', async () => {
    const { scope, api } = await consoleAt(A)
    const fromA = api.cookrew().getWorkspace()
    const ended = expect(fromA).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    expect(to(BASE_A, '/api/workspace')).toHaveLength(1)
    scope.enterMachine(B)
    const fromB = api.cookrew().getWorkspace()
    await tick()
    expect(to(BASE_B, '/api/workspace')).toHaveLength(1)
    // The last machine answers late: whoever asked is its view, and is gone.
    to(BASE_A, '/api/workspace')[0].answer(json({ id: 'workspace-of-a', nodes: [] }))
    await ended
    to(BASE_B, '/api/workspace')[0].answer(json({ id: 'workspace-of-b', nodes: [] }))
    expect(((await fromB) as unknown as { id: string }).id).toBe('workspace-of-b')
  })

  it('never types into the next machine what was typed for the last', async () => {
    const { scope, api } = await consoleAt(A)
    const remote = api.cookrew()
    remote.ptyInput('t1', 'a')
    remote.ptyInput('t1', 'b')
    remote.ptyInput('t1', 'c')
    await tick()
    const typedAtA = to(BASE_A, '/api/terminal/t1/raw')
    expect(typedAtA).toHaveLength(1)
    scope.enterMachine(B)
    // What was on its way is stopped; what waited behind it is gone.
    expect(typedAtA[0].init.signal?.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent.filter((one) => one.url.includes('/api/terminal/'))).toHaveLength(1)
    api.cookrew().ptyInput('t9', 'x')
    await tick()
    const typedAtB = to(BASE_B, '/api/terminal/')
    expect(typedAtB).toHaveLength(1)
    expect(typedAtB[0].url).toBe(`${BASE_B}/api/terminal/t9/raw`)
    expect(JSON.parse(String(typedAtB[0].init.body)).data).toBe('x')
  })

  it('keeps each machine’s pairing token under that machine’s key, and reads the one in scope', async () => {
    const { scope } = await consoleAt(A)
    const gate = await import('../src/renderer/src/auth-gate')
    expect(gate.authStore().token()).toBeNull()
    gate.authStore().save('token-for-a')
    scope.enterMachine(B)
    expect(gate.authStore().token()).toBeNull()
    expect(gate.authHeaders()).toEqual({})
    gate.authStore().save('token-for-b')
    scope.enterMachine(A)
    expect(gate.authStore().token()).toBe('token-for-a')
    scope.enterMachine(B)
    expect(gate.authHeaders()).toEqual({ authorization: 'Bearer token-for-b' })
    const stored = (globalThis as unknown as { localStorage: Storage }).localStorage
    expect(stored.getItem(`cr_token:${A}`)).toBe('token-for-a')
    expect(stored.getItem(`cr_token:${B}`)).toBe('token-for-b')
  })

  it('keeps each machine’s seat for that machine', async () => {
    const { scope } = await consoleAt(A)
    const seat = await import('../src/renderer/src/device-seat')
    expect(seat.deviceSeat()).toBeNull()
    seat.takeSeat('workspace-on-a')
    expect(seat.seated('/api/state')).toBe('/api/state?seat=workspace-on-a')
    scope.enterMachine(B)
    expect(seat.deviceSeat()).toBeNull()
    expect(seat.seated('/api/state')).toBe('/api/state')
    seat.takeSeat('workspace-on-b')
    scope.enterMachine(A)
    expect(seat.deviceSeat()).toBe('workspace-on-a')
  })
})
