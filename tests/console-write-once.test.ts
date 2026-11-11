import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { inConsole, relayBaseFor } from './support/console-scope'

/**
 * A WRITE IS SENT ONCE, ON ONE PATH (0.6.0, decision F2). When the path under
 * a write goes away, the page does not send the write again on another one:
 * it may have landed, and landing twice is an answer given twice. The person
 * is told it did not go through, and the screen shows what the machine says.
 *
 * Keystrokes are the one write that IS sent again, because they carry a batch
 * id the machine remembers: a batch that comes twice is typed once.
 */

const M = '11111111-1111-4111-8111-111111111111'
const BASE = relayBaseFor(M)
const LAN = `https://192-168-1-24.${M}.d.cookrew.dev:8643`

interface Sent {
  url: string
  init: RequestInit
}
let sent: Sent[] = []
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  sent = []
  vi.resetModules()
  const page = bareWindow('https://console.cookrew.dev/')
  ;(page.localStorage as Storage).setItem(`cr_token:${M}`, 'machine-token')
  vi.stubGlobal('window', page)
  vi.stubGlobal('localStorage', page.localStorage)
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit = {}) =>
        new Promise<Response>((_, fail) => {
          sent.push({ url: String(url), init })
          init.signal?.addEventListener('abort', () => fail(init.signal?.reason ?? new DOMException('aborted', 'AbortError')), { once: true })
        })
    )
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a write whose path goes away under it', () => {
  it('a menu answer is not sent again on the relay: the person hears it did not go through', async () => {
    await inConsole(M)
    const plane = await import('../src/renderer/src/data-plane')
    const api = await import('../src/renderer/src/api')
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    const answering = api.cookrew().answerMenu?.('t1', { index: 0 } as never) as Promise<unknown>
    const failed = expect(answering).rejects.toBeDefined()
    await tick()
    const first = sent.filter((one) => one.url.includes('/api/terminal/t1/menu'))
    expect(first.map((one) => one.url)).toEqual([`${LAN}/api/terminal/t1/menu`])

    plane.fallBackToRelay()
    await failed
    await tick(50)
    expect(sent.filter((one) => one.url.includes('/api/terminal/t1/menu'))).toHaveLength(1)
  })

  it('a keystroke batch is sent again on the relay under the same id, so the machine types it once', async () => {
    await inConsole(M)
    const plane = await import('../src/renderer/src/data-plane')
    const api = await import('../src/renderer/src/api')
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    api.cookrew().ptyInput('t1', 'ls\r')
    await tick()
    const first = sent.filter((one) => one.url.includes('/api/terminal/t1/raw'))
    expect(first.map((one) => one.url)).toEqual([`${LAN}/api/terminal/t1/raw`])

    plane.fallBackToRelay()
    await vi.waitFor(() => expect(sent.filter((one) => one.url.includes('/api/terminal/t1/raw'))).toHaveLength(2))
    const [direct, relayed] = sent.filter((one) => one.url.includes('/api/terminal/t1/raw'))
    expect(relayed.url).toBe(`${BASE}/api/terminal/t1/raw`)
    const bodyOf = (one: Sent): { data: string; id: string } => JSON.parse(String(one.init.body)) as { data: string; id: string }
    expect(bodyOf(relayed)).toEqual(bodyOf(direct))
    expect(bodyOf(direct).id.length).toBeGreaterThan(0)
    // The relayed one carries the account session; the direct one never did.
    expect(new Headers(direct.init.headers).get('x-cookrew-session')).toBeNull()
    expect(new Headers(relayed.init.headers).get('x-cookrew-session')).toBe('account-session')
  })
})
