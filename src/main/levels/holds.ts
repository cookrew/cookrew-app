/**
 * The desktop levels view's hold on the levels service.
 *
 * A renderer that shows the levels says so over IPC (levels:subscribe) and
 * gets every LevelsEvent pushed (levels:event): a snapshot first, then the
 * deltas — the same events the companion's SSE stream sends, from the same
 * service, so the window and the phone can never drift apart. It releases
 * with levels:unsubscribe, or without saying anything when the page reloads,
 * the renderer crashes or the webContents ends (the board hold's rules).
 *
 * Refcounted per sender. Every subscribe reopens the service stream, so the
 * subscriber that just arrived starts from a snapshot like the first one did.
 */
import type { LevelsEvent } from '../../shared/strata'
import { navigationEndsHold, type NavigationDetails } from '../board-hold'
import type { LevelsService } from './service'

/** The slice of Electron's WebContents the hold needs — fakeable. */
export interface LevelsSender {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: LevelsEvent): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface LevelsHolds {
  /** One more hold for this sender, and a fresh snapshot to it. False when no service is wired. */
  subscribe(sender: LevelsSender): boolean
  /** One hold fewer; the last one closes the stream. False when the sender held nothing. */
  unsubscribe(sender: LevelsSender): boolean
  /** Senders currently holding (tests, /api/health). */
  count(): number
}

interface Hold {
  count: number
  stream: () => void
  release: () => void
}

export const LEVELS_EVENT_CHANNEL = 'levels:event'

export function createLevelsHolds(service: () => LevelsService | null): LevelsHolds {
  const holds = new Map<number, Hold>()

  const openStream = (levels: LevelsService, sender: LevelsSender): (() => void) =>
    levels.subscribe((event) => {
      if (!sender.isDestroyed()) sender.send(LEVELS_EVENT_CHANNEL, event)
    })

  const open = (levels: LevelsService, sender: LevelsSender): Hold => {
    const gone = (): void => release()
    const navigated = (details: unknown): void => {
      if (navigationEndsHold(details as NavigationDetails | undefined)) release()
    }
    const hold: Hold = { count: 1, stream: openStream(levels, sender), release: () => undefined }
    // A release from an earlier cycle cannot end a newer hold: the map must still point at this one.
    const release = (): void => {
      if (holds.get(sender.id) !== hold) return
      holds.delete(sender.id)
      hold.stream()
      sender.removeListener('destroyed', gone)
      sender.removeListener('render-process-gone', gone)
      sender.removeListener('did-start-navigation', navigated)
    }
    hold.release = release
    sender.on('destroyed', gone)
    sender.on('render-process-gone', gone)
    sender.on('did-start-navigation', navigated)
    return hold
  }

  return {
    subscribe: (sender) => {
      const levels = service()
      if (!levels) return false
      try {
        const held = holds.get(sender.id)
        if (!held) {
          holds.set(sender.id, open(levels, sender))
          return true
        }
        // The new stream first: a build that throws leaves the window its old one.
        const stream = openStream(levels, sender)
        held.stream()
        held.stream = stream
        held.count += 1
        return true
      } catch (error) {
        console.error('Levels stream could not open:', error)
        return false
      }
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
