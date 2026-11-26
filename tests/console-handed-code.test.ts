import { describe, expect, it, vi } from 'vitest'
import { HANDED_CODE_KEY, forgetHandedCode, landHandedCode, takeHandedCode } from '../src/renderer/src/console/handed-code'
import { nextCodeKey, takeNextCode } from '../src/renderer/src/pairing-scope'
import { pairingHandout } from '../src/main/pairing-handout'
import { renderMobileHelp } from '../src/main/mobile-cli-text'
import type { ConsoleMachine } from '../src/renderer/src/console/console-devices'
import type { ConsoleRoute } from '../src/renderer/src/console/console-route'
import type { EnterResult } from '../src/renderer/src/account-pair-client'
import { memory } from './support/console-client'
import { inConsole } from './support/console-scope'

/**
 * THE UNLOCK CODE, FROM A MACHINE'S OWN SCREEN TO THE CONSOLE. Unlocking a
 * machine's screen from afar goes through a sealed session the relay cannot
 * read, keyed by a code that must reach the phone without passing the relay.
 * It rides the FRAGMENT of the link the machine draws on its own screen (a QR,
 * never a terminal): `<console>/d/<machine>#code=<code>`. A fragment is never
 * sent to any server. The code opens nothing: signing in, the gate and the
 * machine's own door still stand between a scanner and the machine.
 */

const M = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const OTHER = '11111111-1111-4111-8111-111111111111'
const CODE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ'
const machineRoute = (machine: string) => ({ kind: 'machine' as const, machine, workspace: null, agent: null, side: 'agents' as const })
const keyFor = (machine: string): string => `cr_code:${machine}`

describe('the machine’s own screen', () => {
  const deps = (code: string | null) => ({
    account: () => ({ username: 'drej', deviceId: M, name: 'Studio Mac' }),
    consoleOrigin: () => 'https://console.cookrew.dev',
    endpoints: () => [],
    pairingToken: () => 'tok',
    connectCode: () => code
  })

  it('draws the console address with the code after the #, and nothing else secret', () => {
    const handout = pairingHandout(deps(CODE))
    const url = new URL(handout?.url ?? '')
    expect(url.origin + url.pathname).toBe(`https://console.cookrew.dev/d/${M}`)
    expect(url.search).toBe('')
    expect(url.hash).toBe(`#code=${CODE}`)
    expect(handout?.url).not.toContain('tok')
  })

  it('draws the bare address when there is no code', () => {
    expect(pairingHandout(deps(null))?.url).toBe(`https://console.cookrew.dev/d/${M}`)
  })

  it('never prints the code in a terminal: `cookrew mobile` prints the address alone', () => {
    const text = renderMobileHelp({ endpoints: [], pairing: pairingHandout(deps(CODE)), secure: true, uncovered: [], tailnet: false })
    expect(text).toContain(`https://console.cookrew.dev/d/${M}`)
    expect(text).not.toContain(CODE)
    expect(text).not.toContain('#')
  })
})

describe('the console, opened at that link', () => {
  it('takes the code off the address for the machine the address names, and keeps it for this tab only', () => {
    const pending = memory()
    expect(takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })).toBe(true)
    expect(JSON.parse(pending.getItem(HANDED_CODE_KEY) ?? '{}')).toEqual({ machine: M, code: CODE })
  })

  it('takes nothing from an address that names no machine, or carries no code, or something else', () => {
    const pending = memory()
    expect(takeHandedCode({ hash: `#code=${CODE}`, route: { kind: 'devices' }, pending })).toBe(false)
    expect(takeHandedCode({ hash: '', route: machineRoute(M), pending })).toBe(false)
    expect(takeHandedCode({ hash: '#pair=a-token', route: machineRoute(M), pending })).toBe(false)
    expect(pending.all.size).toBe(0)
  })

  it('files it under that machine when that machine is entered, and under no other', () => {
    const pending = memory()
    const kept = memory()
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    landHandedCode({ machineId: OTHER, pending, kept, keyFor })
    expect(kept.all.size).toBe(0)
    landHandedCode({ machineId: M, pending, kept, keyFor })
    expect(kept.getItem(`cr_code:${M}`)).toBe(CODE)
    // Used: it does not wait in the tab for another machine.
    expect(pending.getItem(HANDED_CODE_KEY)).toBeNull()
  })

  it('does not replace a code already held for that machine: it waits beside it, for when the held one is refused', () => {
    // A link somebody else made (`…/d/<machine>#code=<theirs>`) must not be able to throw a good
    // code away: remote unlock would be broken until the person is back at the machine to rescan.
    const pending = memory()
    const kept = memory()
    kept.setItem(`cr_code:${M}`, 'the-code-that-works')
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    landHandedCode({ machineId: M, pending, kept, keyFor })
    expect(kept.getItem(`cr_code:${M}`)).toBe('the-code-that-works')
    expect(kept.getItem(nextCodeKey(`cr_code:${M}`))).toBe(CODE)
    // The machine refuses the held code (it rotated its own): the one that waited is tried, once.
    expect(takeNextCode(kept, `cr_code:${M}`)).toBe(CODE)
    expect(takeNextCode(kept, `cr_code:${M}`)).toBeNull()
  })

  it('the same code handed again changes nothing', () => {
    const pending = memory()
    const kept = memory()
    kept.setItem(`cr_code:${M}`, CODE)
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    landHandedCode({ machineId: M, pending, kept, keyFor })
    expect(kept.getItem(nextCodeKey(`cr_code:${M}`))).toBeNull()
  })

  it('signing out forgets a code that was still waiting in the tab', () => {
    const pending = memory()
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    forgetHandedCode(pending)
    expect(pending.getItem(HANDED_CODE_KEY)).toBeNull()
  })

  it('survives the trip to the sign-in page and back, which is the same tab', () => {
    const pending = memory()
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    // …the browser goes to the auth host and comes back: another page load, the same tab's storage.
    const kept = memory()
    landHandedCode({ machineId: M, pending, kept, keyFor })
    expect(kept.getItem(`cr_code:${M}`)).toBe(CODE)
  })
})

/**
 * THE DOOR IS ASKED BEFORE THE MACHINE IS IN SCOPE (console-runtime.ts: open-door, then enter). On a
 * machine that takes only sealed connections the door's own begin must go sealed, so the code its own
 * screen handed over is filed when that door is asked, not only when the machine is entered after it.
 * Driven through the real runtime and the console's real door; only the door's answer is a stand-in,
 * and it looks at what this browser holds at the moment it is asked.
 */
describe('a fresh link to a machine that takes only sealed connections', () => {
  const live = (id: string): ConsoleMachine => ({ id, name: id === M ? 'Studio Mac' : 'Solis', os: 'darwin', online: true, lastSeenAt: 1, standing: 'live', say: null, workspaces: [], counts: null, view: null })
  const fixed = <T>(value: T) => ({ get: () => value, subscribe: () => () => undefined })

  async function openAt(route: ConsoleRoute, start: { handedFor: string; held?: string; answer?: (machineId: string) => EnterResult | undefined }) {
    vi.resetModules()
    const scope = await inConsole(null)
    const { createConsoleRuntime } = await import('../src/renderer/src/console/console-runtime')
    const { createMachineDoor } = await import('../src/renderer/src/console/console-wiring')
    const { tokenKeyForBase } = await import('../src/renderer/src/pairing-scope')
    const pending = memory()
    const kept = memory()
    if (start.held !== undefined) kept.setItem(keyFor(M), start.held)
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(start.handedFor), pending })
    const log: string[] = []
    let at = route
    const atDoor: Array<{ machine: string; code: string | null; next: string | null; other: string | null }> = []
    /** Whether each door was asked by a person (or a code that just landed), in order. */
    const asks: boolean[] = []
    const door = createMachineDoor({
      kept,
      pending,
      signedIn: () => true,
      enter: async (_target, machineId, explicit): Promise<EnterResult> => {
        log.push(`door ${machineId}`)
        asks.push(explicit)
        atDoor.push({ machine: machineId, code: kept.getItem(keyFor(machineId)), next: kept.getItem(nextCodeKey(keyFor(machineId))), other: kept.getItem(keyFor(OTHER)) })
        return start.answer?.(machineId) ?? { kind: 'entered', token: 'a-key', desktopId: machineId, until: 9e15 }
      }
    })
    const runtime = createConsoleRuntime({
      session: { ...fixed({ status: 'signed-in' as const, username: 'drej' }), boot: async () => undefined, complete: async () => ({ ok: false as const, intent: 'sign-in' as const, returnTo: '/', message: 'no' }), signIn: async () => ({ ok: true as const }), signOut: async () => ({ ended: true }) },
      gate: { ...fixed({ status: 'open' as const, until: 9e15 }), check: async () => undefined, took: async () => undefined, forget: () => undefined },
      devices: { ...fixed({ status: 'ready' as const, machines: [live(M), live(OTHER)], error: null }), start: () => () => undefined, gateChanged: () => undefined },
      // A router that goes where it is sent: a refused door sends the page back to the machines.
      router: { get: () => at, subscribe: () => () => undefined, go: (next) => void (at = next) },
      openDoor: door.open,
      // As the console's own: the key this browser held for the machine is let go, so the door is asked again.
      forgetDoor: (id) => kept.removeItem(tokenKeyForBase(scope.machineBaseOf(id) as string)),
      enterScope: (id) => void log.push(`scope ${id}`),
      takeSeat: () => undefined,
      forgetMachines: () => undefined
    })
    await runtime.boot()
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    return { log, atDoor, asks, pending, kept, runtime, door }
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  }

  it('the door a person opened is asked explicitly; the runtime asking again on its own (a key refused) is not', async () => {
    const { runtime, asks } = await openAt(machineRoute(M), { handedFor: OTHER })
    expect(asks).toEqual([true])
    runtime.keyRefused(M)
    await settle()
    expect(asks).toEqual([true, false])
  })

  it('a code that has just landed for this machine makes the ask explicit, even one the runtime made on its own', async () => {
    const notYet = (id: string): EnterResult | undefined => (id === M ? { kind: 'needs-proof' } : undefined)
    const { door, asks, pending } = await openAt(machineRoute(OTHER), { handedFor: OTHER, answer: notYet })
    // A fresh scan for M, landing as M's door is asked again with no one pressing anything.
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    await door.open(M, { explicit: false })
    // Nothing new landed: the next ask on its own is not explicit.
    await door.open(M, { explicit: false })
    expect(asks.slice(-2)).toEqual([true, false])
  })

  it('a code handed for another machine makes nothing explicit here', async () => {
    const notYet = (id: string): EnterResult | undefined => (id === M ? { kind: 'needs-proof' } : undefined)
    const { door, asks, pending } = await openAt(machineRoute(OTHER), { handedFor: OTHER, answer: notYet })
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(OTHER), pending })
    await door.open(M, { explicit: false })
    expect(asks.at(-1)).toBe(false)
  })

  it('a sealed-only sentence is the page\'s own: said whole, and not put in the machine\'s mouth', async () => {
    const { SEALED_ONLY_COPY } = await import('../src/renderer/src/account-pair-client')
    for (const sentence of Object.values(SEALED_ONLY_COPY)) {
      const { runtime } = await openAt(machineRoute(M), { handedFor: M, answer: () => ({ kind: 'failed', message: sentence }) })
      expect(runtime.get().notice).toBe(sentence)
    }
    // The longest is longer than a machine's words are cut to: whole all the same.
    expect(Math.max(...Object.values(SEALED_ONLY_COPY).map((sentence) => sentence.length))).toBeGreaterThan(160)
  })

  it('the real door\'s sealed-only refusal reaches the page as the page\'s own', async () => {
    const { enterWithGrant, SEALED_ONLY_COPY } = await import('../src/renderer/src/account-pair-client')
    const device = { id: 'dev-1', jwk: {} as Record<string, string>, name: 'console', sign: async () => new Uint8Array(64).buffer }
    const grants = { read: () => ({ grant: 'g', exp: 9e15, deviceId: 'dev-1' }), write: () => undefined, clear: () => undefined }
    const sealedOnly = { get: async () => ({ status: 404, body: null }), post: async () => ({ status: 403, body: { error: 'sealed-only', seal: 'code-replaced' } }) }
    const said = await enterWithGrant({ machine: sealedOnly, registry: sealedOnly, device: async () => device, passkey: null, grants }, M)
    const { runtime } = await openAt(machineRoute(M), { handedFor: M, answer: () => said })
    expect(runtime.get().notice).toBe(SEALED_ONLY_COPY.codeReplaced)
  })

  it('the door, asked before the machine is in scope, already finds the code that machine handed over', async () => {
    const { log, atDoor, pending } = await openAt(machineRoute(M), { handedFor: M })
    expect(log).toEqual([`door ${M}`, `scope ${M}`])
    expect(atDoor).toEqual([{ machine: M, code: CODE, next: null, other: null }])
    expect(pending.getItem(HANDED_CODE_KEY)).toBeNull()
  })

  it('a code handed for another machine is not filed for this one, and still waits for its own', async () => {
    const { atDoor, pending, kept } = await openAt(machineRoute(M), { handedFor: OTHER })
    expect(atDoor).toEqual([{ machine: M, code: null, next: null, other: null }])
    expect([...kept.all.keys()].filter((key) => key.startsWith('cr_code'))).toEqual([])
    expect(JSON.parse(pending.getItem(HANDED_CODE_KEY) ?? '{}')).toEqual({ machine: OTHER, code: CODE })
  })

  it('a code already held is not replaced at the door either: the handed one waits beside it', async () => {
    const { atDoor, kept } = await openAt(machineRoute(M), { handedFor: M, held: 'the-code-that-works' })
    expect(atDoor).toEqual([{ machine: M, code: 'the-code-that-works', next: CODE, other: null }])
    expect(kept.getItem(keyFor(M))).toBe('the-code-that-works')
  })
})
