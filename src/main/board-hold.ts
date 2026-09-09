/**
 * The desktop board panel's hold on the probe.
 *
 * A renderer that opens the board says so over IPC (board:subscribe), gets
 * the board pushed on every change (board:update, coalesced), and releases
 * with board:unsubscribe — or without saying anything, because a reload
 * destroys the JS context and not the webContents, so the preload's
 * release never runs. The hold therefore also goes with the navigation
 * that reloads the page, a renderer crash, and the webContents' end.
 *
 * Refcounted per sender so two panels in one window share one hold.
 * Extracted from index.ts so every one of those releases has a unit.
 */
import type { BoardSnapshot, BoardSources } from './board-index'
import { buildBoard, createBoardNotifier } from './board-index'

/** The slice of Electron's WebContents the hold needs — fakeable. */
export interface HoldSender {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: BoardSnapshot): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/** What did-start-navigation says about itself, in the details form. */
export interface NavigationDetails {
  isMainFrame?: boolean
  isSameDocument?: boolean
}

/** A signal source the board rebuilds on (TurnTracker, WorkspaceStore). */
export interface HoldSignals {
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

export interface BoardHoldDeps {
  sources: () => BoardSources
  turns: HoldSignals
  store: HoldSignals
}

export interface BoardHolds {
  /** One more hold for this sender; the first one subscribes the probe. Returns true. */
  subscribe(sender: HoldSender): boolean
  /** One hold fewer; the last one releases. False when the sender held nothing. */
  unsubscribe(sender: HoldSender): boolean
  /** Senders currently holding (tests, /api/health). */
  count(): number
}

/**
 * Only a navigation that REPLACES THE PAGE ends the hold: a sub-frame
 * (a legacy iframe card) navigating, or history.replaceState (the auth
 * gate), leaves the renderer — and its panel — exactly where they were.
 * A form without the fields (older positional args) is taken as the page
 * going, which is the safe side: a released hold costs one re-subscribe.
 */
export function navigationEndsHold(details: NavigationDetails | undefined): boolean {
  if (!details) return true
  return details.isMainFrame !== false && details.isSameDocument !== true
}

export function createBoardHolds(deps: BoardHoldDeps): BoardHolds {
  const holds = new Map<number, { count: number; release: () => void }>()

  const open = (sender: HoldSender): (() => void) => {
    const sources = deps.sources()
    const notifier = createBoardNotifier(() => {
      if (!sender.isDestroyed()) sender.send('board:update', buildBoard(sources))
    })
    const releaseProbe = sources.probeSubscribe?.() ?? (() => undefined)
    const offChange = sources.probeOnChange?.(() => notifier.schedule()) ?? (() => undefined)
    const onSignal = (): void => notifier.schedule()
    deps.turns.on('activity', onSignal)
    deps.store.on('change', onSignal)
    deps.store.on('workspaces', onSignal)
    const gone = (): void => release()
    const navigated = (details: unknown): void => {
      if (navigationEndsHold(details as NavigationDetails | undefined)) release()
    }
    // Every listener is removed INSIDE release, and a release from an
    // earlier cycle cannot delete a newer hold: the map must still point at
    // this very function.
    const release = (): void => {
      if (holds.get(sender.id)?.release !== release) return
      holds.delete(sender.id)
      notifier.cancel()
      offChange()
      releaseProbe()
      deps.turns.removeListener('activity', onSignal)
      deps.store.removeListener('change', onSignal)
      deps.store.removeListener('workspaces', onSignal)
      sender.removeListener('destroyed', gone)
      sender.removeListener('render-process-gone', gone)
      sender.removeListener('did-start-navigation', navigated)
    }
    sender.on('destroyed', gone)
    sender.on('render-process-gone', gone)
    sender.on('did-start-navigation', navigated)
    return release
  }

  return {
    subscribe: (sender) => {
      const held = holds.get(sender.id)
      if (held) {
        held.count += 1
        return true
      }
      const release = open(sender)
      holds.set(sender.id, { count: 1, release })
      return true
    },
    unsubscribe: (sender) => {
      const held = holds.get(sender.id)
      if (!held) return false
      held.count -= 1
      if (held.count <= 0) held.release()
      return true
    },
    count: () => holds.size
  }
}
