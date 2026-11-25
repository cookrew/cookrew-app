import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'

/**
 * THE GUEST, BOOTED (renderer guest/guest-wiring.ts): in a guest machine's
 * <webview> the renderer's entry is a console page with that one machine in
 * scope, its relay at the page's own origin (main carries it), its key where
 * the console keeps a machine's key. Anywhere else it is nothing at all.
 */

const SOLIS = '0f8c7b1e-1234-4abc-9def-0123456789ab'
const ATTIC = '1a2b3c4d-1234-4abc-9def-0123456789ab'
const ORIGIN = `cookrew-machine://${SOLIS}`
const KEY = 'K'.repeat(32)

const page = (over: Record<string, unknown> = {}) => ({
  protocol: 'cookrew-machine:',
  origin: ORIGIN,
  href: `${ORIGIN}/?w=w-1&a=t-1&theme=root`,
  search: '?w=w-1&a=t-1&theme=root',
  bridge: undefined,
  takeBoot: () => ({ machine: SOLIS, key: KEY }),
  ...over
})

beforeEach(() => {
  vi.resetModules()
  const win = bareWindow(`https://localhost/`)
  vi.stubGlobal('window', win)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('wireGuest', () => {
  it('is the console for that one machine: its relay at this page’s origin, the machine in scope, its key held', async () => {
    const { wireGuest, GUEST_SESSION } = await import('../src/renderer/src/guest/guest-wiring')
    const scope = await import('../src/renderer/src/machine-scope')
    const parts = wireGuest(page())
    expect(parts).toEqual({ machine: SOLIS, entry: { workspace: 'w-1', agent: 't-1', item: null, side: 'agents' }, theme: 'root', keyHeld: true })
    expect(scope.machineScope()).toMatchObject({ machineId: SOLIS, relay: { origin: ORIGIN } })
    expect(scope.machineScope().relay?.session()).toBe(GUEST_SESSION)
    expect(scope.machineBaseOf(SOLIS)).toBe(`${ORIGIN}/api/m/${SOLIS}`)
    const { authStore } = await import('../src/renderer/src/auth-gate')
    expect(authStore().token()).toBe(KEY)
    // Where the console keeps a machine's key, by its id (pairing-scope.ts).
    expect((window as unknown as { localStorage: Storage }).localStorage.getItem(`cr_token:${SOLIS}`)).toBe(KEY)
  })

  it('a page with the window’s bridge is the desktop itself: nothing is made, and the boot line is never read', async () => {
    const { wireGuest } = await import('../src/renderer/src/guest/guest-wiring')
    const takeBoot = vi.fn(() => ({ machine: SOLIS, key: KEY }))
    expect(wireGuest(page({ bridge: {}, takeBoot }))).toBeNull()
    expect(takeBoot).not.toHaveBeenCalled()
  })

  it('anywhere but the guest’s scheme (a phone, the console) it is nothing', async () => {
    const { wireGuest } = await import('../src/renderer/src/guest/guest-wiring')
    const scope = await import('../src/renderer/src/machine-scope')
    expect(wireGuest(page({ protocol: 'https:' }))).toBeNull()
    expect(scope.machineScope().relay).toBeNull()
  })

  it('a boot line for another machine than its address names, or none, is nothing', async () => {
    const { wireGuest } = await import('../src/renderer/src/guest/guest-wiring')
    expect(wireGuest(page({ takeBoot: () => ({ machine: ATTIC, key: KEY }) }))).toBeNull()
    expect(wireGuest(page({ takeBoot: () => undefined }))).toBeNull()
  })

  it('with no key held for it yet, the machine is in scope and the guest says it has none', async () => {
    const { wireGuest } = await import('../src/renderer/src/guest/guest-wiring')
    expect(wireGuest(page({ takeBoot: () => ({ machine: SOLIS, key: null }) }))?.keyHeld).toBe(false)
  })
})

describe('the guest’s way out, and the window’s steps', () => {
  it('the zoom arriving at the devices stop is leaving the machine: the window is told', async () => {
    const { guestRouter } = await import('../src/renderer/src/guest/guest-steps')
    const leave = vi.fn()
    const router = guestRouter(SOLIS, { workspace: 'w-1', agent: null, item: null, side: 'agents' }, leave)
    expect(router.get()).toEqual({ kind: 'machine', machine: SOLIS, workspace: 'w-1', agent: null, side: 'agents' })
    router.go({ kind: 'machine', machine: SOLIS, workspace: 'w-1', agent: 't-1', side: 'agents' })
    expect(router.get()).toMatchObject({ agent: 't-1' })
    expect(leave).not.toHaveBeenCalled()
    router.go({ kind: 'devices' })
    expect(leave).toHaveBeenCalledWith('devices')
  })

  it('the device step goes to its workspaces, and from there out; the workspace step to its crew', async () => {
    const { runGuestCommand } = await import('../src/renderer/src/guest/guest-steps')
    const { zoomStore } = await import('../src/renderer/src/zoom/zoom-store')
    const leave = vi.fn()
    zoomStore.go(2, 'agents')
    runGuestCommand({ kind: 'device' }, leave)
    expect(zoomStore.get().v).toBe(-1)
    runGuestCommand({ kind: 'device' }, leave)
    expect(zoomStore.get().v).toBe(-2)
    runGuestCommand({ kind: 'workspace' }, leave)
    expect(zoomStore.get()).toMatchObject({ v: 1, dir: 'agents' })
  })
})

describe('the entry', () => {
  it('in the guest, the renderer’s entry is wired first, and a guest draws no phone of its own', async () => {
    const { readFileSync } = await import('node:fs')
    const entry = readFileSync('src/renderer/src/main.tsx', 'utf8')
    const firstImport = entry.split('\n').find((line) => line.startsWith('import '))
    expect(firstImport).toBe("import { guestParts } from './guest/guest-wiring'")
    expect(entry).toContain('if (guestParts === null) startPhoneBeacon()')
    // No direct link to that machine: every call goes through the door the owner's lock closes.
    expect(entry).toContain('if (guestParts === null) startMachineSession()')
    expect(entry).toContain('<GuestMachine parts={guestParts} />')
  })
})
