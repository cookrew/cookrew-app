// What main lends the wrist's routes (watch-routes.ts), put together once.

import { nativeImage } from 'electron'
import { nameFromPrompt } from '../shared/agent-name'
import type { CanvasNode, Connection } from '../shared/model'
import type { BrowserInstance } from './browser-instance'
import type { MobileEndpoint } from './mobile-endpoints'
import { watchBases } from './watch-bases'
import type { WatchHost } from './watch-routes'
import type { WatchPairing } from './watch-pairing'

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
}

export function createWatchHost(deps: WatchHostDeps): WatchHost {
  /** The last picture made small, kept while its source stands: a poll of a still page costs no resize. */
  let shrunk: { source: Buffer; width: number; data: Buffer } | null = null
  return {
    pairing: deps.pairing,
    desktopName: deps.deviceName,
    bases: () => watchBases(deps.endpoints(), deps.httpPort),
    canvas: deps.canvas,
    async frame(browserId, width) {
      await deps.thumbViewed(browserId)
      const thumb = deps.thumb(browserId)
      if (!thumb) return null
      if (shrunk?.source === thumb.data && shrunk.width === width) return { type: 'image/jpeg', data: shrunk.data }
      const image = nativeImage.createFromBuffer(thumb.data)
      if (image.isEmpty() || image.getSize().width <= width) return thumb
      const data = image.resize({ width, quality: 'good' }).toJPEG(62)
      shrunk = { source: thumb.data, width, data }
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
    stop: deps.stop
  }
}
