/**
 * THE GUEST, PUT IN PLACE (machine-guest.ts is the door; this hangs it).
 *
 *   before `ready`   the guest's scheme is a page origin of its own, with fetch and
 *                    streams (protocol.registerSchemesAsPrivileged)
 *   at `ready`       the scheme is served in the guest's session, and only there
 *   per window       a <webview> in the guest's session gets the guest's preload,
 *                    set here and never by the page; a guest address anywhere else
 *                    is refused (will-attach-webview). Once attached it stays on its
 *                    own machine's page: a link elsewhere opens in the system browser
 */
import { readFile } from 'node:fs/promises'
import { protocol, session, shell, type WebContents } from 'electron'
import { MACHINE_GUEST_PARTITION, MACHINE_GUEST_SCHEME } from '../shared/machine-guest'
import { rendererDevTarget } from './renderer-dev-proxy'
import {
  MACHINE_GUEST_PRIVILEGES,
  builtAssetPath,
  createMachineGuestDoor,
  devAssetAllowed,
  guestAttach,
  mimeOf,
  staysInGuest,
  type GuestAsset,
  type MachineGuestDeps,
  type MachineGuestDoor
} from './machine-guest'

/** Before the app is ready, once. */
export function registerMachineGuestScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MACHINE_GUEST_SCHEME, privileges: { ...MACHINE_GUEST_PRIVILEGES } }])
}

/** The renderer build's files, or (development) the local Vite server's. */
export function guestAssets(rendererDir: string, rendererDevUrl: string | undefined): MachineGuestDeps['asset'] {
  if (rendererDevUrl) {
    return async (pathname, search) => {
      if (!devAssetAllowed(pathname)) return null
      const target = rendererDevTarget(rendererDevUrl, pathname, search)
      if (target === null) return null
      try {
        const answer = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
        if (!answer.ok) return null
        return { body: await answer.arrayBuffer(), type: answer.headers.get('content-type') ?? mimeOf(pathname) }
      } catch {
        return null
      }
    }
  }
  return async (pathname): Promise<GuestAsset | null> => {
    const file = builtAssetPath(rendererDir, pathname)
    if (file === null) return null
    try {
      const bytes = await readFile(file)
      return { body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: mimeOf(file) }
    } catch {
      return null
    }
  }
}

/** At `ready`: the guest's session serves the guest's scheme. The door is handed back so main can cut it. */
export function installMachineGuest(deps: MachineGuestDeps): MachineGuestDoor {
  const door = createMachineGuestDoor(deps)
  session.fromPartition(MACHINE_GUEST_PARTITION).protocol.handle(MACHINE_GUEST_SCHEME, door.handle)
  return door
}

/** Is this webContents a guest machine's page (its session is the guest's). */
export function isMachineGuest(contents: WebContents): boolean {
  return contents.session === session.fromPartition(MACHINE_GUEST_PARTITION)
}

/** Anything else a person follows from the guest: the system browser for the web, nothing for the rest. */
const openOutside = (url: string): void => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

/** Input that means a person is at the window (a pointer moving over it does not). */
const PRESENT_INPUT = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'mouseWheel', 'touchStart', 'gestureScrollBegin'])

/** How often a person working in the guest is said to be there: the lock needs to know, not every key. */
export const GUEST_PRESENCE_EVERY_MS = 5_000

/**
 * Per window that may hold webviews: the guest gets its own preload and
 * nothing else of this app; the page cannot choose another. A person typing
 * or clicking in it is present at this window (`presence`, the owner lock's
 * activity): its input never reaches the window's own listeners.
 */
export function guardGuestWebviews(contents: WebContents, guestPreload: string, presence: () => void): void {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const verdict = guestAttach(params.partition, params.src)
    if (verdict === 'refuse') {
      event.preventDefault()
      return
    }
    if (verdict !== 'guest') return
    webPreferences.preload = guestPreload
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.sandbox = true
  })
  contents.on('did-attach-webview', (_event, guest) => {
    if (!isMachineGuest(guest)) return
    let last = 0
    guest.on('input-event', (_e, input) => {
      if (!PRESENT_INPUT.has(input.type)) return
      const now = Date.now()
      if (now - last < GUEST_PRESENCE_EVERY_MS) return
      last = now
      presence()
    })
    // Its own machine's page and nothing else: a note's link, a redirect, a page script.
    const keep = (event: Electron.Event, url: string): void => {
      if (staysInGuest(guest.getURL(), url)) return
      event.preventDefault()
      openOutside(url)
    }
    guest.on('will-navigate', keep)
    guest.on('will-redirect', keep)
    guest.setWindowOpenHandler(({ url }) => {
      openOutside(url)
      return { action: 'deny' }
    })
  })
}
