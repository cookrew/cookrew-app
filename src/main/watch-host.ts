// What main lends the wrist's routes (watch-routes.ts), put together once.

import { nativeImage } from 'electron'
import { nameFromPrompt } from '../shared/agent-name'
import { menuHeldOnScreen } from '../shared/wait-choice'
import type { CanvasNode, Connection } from '../shared/model'
import type { BrowserInstance } from './browser-instance'
import type { MobileEndpoint } from './mobile-endpoints'
import { watchBases } from './watch-bases'
import type { WatchAccountKind, WatchHost, WatchInvite } from './watch-routes'
import type { WatchPairing } from './watch-pairing'

/** Shrunk pictures kept: a card's thumbnails and the page open on the wrist. */
const SHRUNK_KEPT = 32

export interface WatchHostDeps {
  readonly pairing: WatchPairing
  readonly deviceName: () => string
  readonly endpoints: () => readonly MobileEndpoint[]
  /** The companion's plain-HTTP port on this Mac. */
  readonly httpPort: number
  readonly canvas: (workspaceId: string) => { nodes: readonly CanvasNode[]; connections: readonly Connection[] }
  readonly node: (id: string) => CanvasNode | undefined
  readonly thumbViewed: (browserId: string) => Promise<void>
  readonly thumb: (browserId: string) => { type: string; data: Buffer } | undefined | null
  readonly browser: (browserId: string) => Promise<BrowserInstance | null>
  /** The harness a new agent gets: the one last used on this Mac. */
  readonly lastPreset: () => string
  readonly createTerminal: (opts: { name: string; preset: string; position: { x: number; y: number }; prompt: string; autoName: boolean }) => { id: string }
  readonly stop: (terminalId: string) => Promise<boolean>
  /** What the terminal shows now; null when nothing is attached. */
  readonly screen: (terminalId: string) => string | null
  readonly workspaces: () => readonly { readonly id: string; readonly name: string }[]
  readonly accountKind: () => WatchAccountKind
  readonly invite: (current: string, here: boolean) => Promise<WatchInvite>
}

export function createWatchHost(deps: WatchHostDeps): WatchHost {
  /** The last picture made small, kept while its source stands: a poll of a still page costs no resize. */
  /** Shrunk pictures, by browser and width: a card's thumbnails and the open page do not push each other out. */
  const shrunk = new Map<string, { source: Buffer; data: Buffer }>()
  return {
    pairing: deps.pairing,
    desktopName: deps.deviceName,
    bases: () => watchBases(deps.endpoints(), deps.httpPort),
    canvas: deps.canvas,
    async frame(browserId, width, peek) {
      // A card nobody has opened has no Chrome yet: looking at it starts one,
      // as a phone opening it does. The next poll has its picture. A thumbnail
      // only peeks: a card's row of them must not start a Chrome each.
      if (!peek) {
        await deps.browser(browserId).catch(() => null)
        await deps.thumbViewed(browserId)
      }
      const thumb = deps.thumb(browserId)
      if (!thumb) return null
      const key = `${browserId}@${width}`
      const known = shrunk.get(key)
      if (known?.source === thumb.data) return { type: 'image/jpeg', data: known.data }
      const image = nativeImage.createFromBuffer(thumb.data)
      if (image.isEmpty() || image.getSize().width <= width) return thumb
      const data = image.resize({ width, quality: 'good' }).toJPEG(62)
      shrunk.delete(key)
      shrunk.set(key, { source: thumb.data, data })
      // The oldest goes first: a few cards' worth is all a wrist looks at.
      while (shrunk.size > SHRUNK_KEPT) shrunk.delete(shrunk.keys().next().value as string)
      return { type: 'image/jpeg', data }
    },
    browser: deps.browser,
    note(noteId) {
      const node = deps.node(noteId)
      return node?.kind === 'note' ? { name: node.name, content: node.content ?? '' } : null
    },
    async makeAgent(words) {
      const made = deps.createTerminal({ name: nameFromPrompt(words), preset: deps.lastPreset(), position: { x: 0, y: 0 }, prompt: words, autoName: true })
      return made.id
    },
    stop: deps.stop,
    speaksTo(terminalId) {
      const node = deps.node(terminalId)
      return node?.kind === 'terminal' && node.command.trim().length > 0
    },
    menuOnScreen(terminalId) {
      const screen = deps.screen(terminalId)
      return screen !== null && menuHeldOnScreen(screen)
    },
    workspaces: deps.workspaces,
    accountKind: deps.accountKind,
    invite: deps.invite
  }
}
