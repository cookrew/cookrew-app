import type { ViewerWho } from '../shared/remote-access'
import type { BrowserInstance } from './browser-instance'

/**
 * A COMPUTER'S SCREEN, WATCHED AND DRIVEN OVER HTTP by another machine of the
 * account (owner 2026-11-10, design B; watch-routes.ts). The relay carries no
 * socket, so that machine cannot hold the cast viewer a phone holds
 * (cast-viewer.ts · attach). It does what that viewer does instead, by its own
 * name: asked at the desk first (refusalFor), then entered (the host lists it,
 * remote-desk.ts · rows), registered (the screen looks while it is watched),
 * and fed the frames. Each read or touch renews it; once they stop it leaves,
 * which ends control after the desk's grace, as a viewer's leaving does.
 */

export type LeasedScreen = Pick<BrowserInstance, 'refusalFor' | 'enterViewer' | 'registerViewportViewer' | 'unregisterViewportViewer'> & {
  readonly frameListeners: Set<(jpegBase64: string, meta: never) => void>
}

export type ScreenLook = { readonly ok: true; readonly jpeg: string | null } | { readonly ok: false; readonly message: string }

export interface ScreenLeases {
  /** The latest picture for this caller, entering as its viewer if it is not one yet. */
  look(instance: LeasedScreen, card: string, who: ViewerWho): ScreenLook
  /** Keep the caller on as it drives; false when the screen refuses it. */
  touch(instance: LeasedScreen, card: string, who: ViewerWho): boolean
}

/** How long a viewer stays on with no read: a few of the page's polls. */
export const SCREEN_LEASE_MS = 6000

interface Lease {
  latest: string | null
  timer: ReturnType<typeof setTimeout>
  end: () => void
}

export function createScreenLeases(ttlMs: number = SCREEN_LEASE_MS): ScreenLeases {
  const leases = new Map<string, Lease>()

  const hold = (instance: LeasedScreen, card: string, who: ViewerWho): Lease | string => {
    const refused = instance.refusalFor?.(who) ?? null
    const viewerId = `http:${who.key}:${card}`
    const held = leases.get(viewerId)
    if (refused) {
      held?.end()
      return refused.message ?? 'That screen cannot be watched from here.'
    }
    if (held) {
      clearTimeout(held.timer)
      held.timer = setTimeout(held.end, ttlMs)
      held.timer.unref?.()
      return held
    }
    const listener = (jpeg: string): void => {
      lease.latest = jpeg
    }
    const leave = instance.enterViewer?.(viewerId, who) ?? null
    instance.registerViewportViewer(viewerId)
    instance.frameListeners.add(listener)
    const lease: Lease = {
      latest: null,
      timer: setTimeout(() => lease.end(), ttlMs),
      end: () => {
        if (leases.get(viewerId) !== lease) return
        leases.delete(viewerId)
        clearTimeout(lease.timer)
        instance.frameListeners.delete(listener)
        instance.unregisterViewportViewer(viewerId)
        leave?.()
      }
    }
    lease.timer.unref?.()
    leases.set(viewerId, lease)
    return lease
  }

  return {
    look(instance, card, who) {
      const lease = hold(instance, card, who)
      return typeof lease === 'string' ? { ok: false, message: lease } : { ok: true, jpeg: lease.latest }
    },
    touch: (instance, card, who) => typeof hold(instance, card, who) !== 'string'
  }
}
