import { randomUUID } from 'node:crypto'
import { activeBrowserTab, type BrowserNodeData } from '../shared/model'
import { parseUseUrl } from '../shared/use-url'
import { cardNameOf, emptySourceList, isUseSourceId, type UseSource, type UseSourceCard, type UseSourceList } from '../shared/use-sources'
import { withDeadline } from './pixel-instance'
import { servedUseRefusal } from './use-commands'

/**
 * WHAT THE PICKER ASKS OF MAIN: ONE SERVICE BEHIND THE IPC AND THE HTTP ROUTES.
 *
 * The served gate lives here, ahead of everything, so a route cannot forget
 * it: a workspace a caller's session runs in is refused before the provider
 * is asked, and that refusal is the same servedUseRefusal the CLI goes
 * through. A card is checked by the workspace it sits in, not only the one
 * the request named.
 *
 * Listing is a capture of every window, so a list is shared while it is in
 * flight and for a moment after. A tap looks its source up in a list the
 * sheet may have shown a while ago; if the window closed since, the card
 * would say so at once anyway, so the longer window costs nothing.
 *
 * A tap makes a card with no input of its own: whether a use takes input is
 * the device's decision (screen-device.ts) and this adds no way around it.
 */

export const USE_SOURCES_FRESH_MS = 2_000
/** Past the capturer's own deadline: a hung read must fail, or every later ask joins it. */
export const USE_SOURCES_LIST_MS = 12_000
const PICK_FRESH_MS = 30_000

export interface UseSourceProvider {
  list(): Promise<UseSourceList>
  openSettings(): Promise<void>
}

export interface UseSourceServiceDeps {
  /** Null on a platform with no screen source. */
  provider(): UseSourceProvider | null
  /** A caller's session runs in this workspace. */
  servedWorkspace(workspaceId: string): boolean
  addCard(workspaceId: string, card: BrowserNodeData): BrowserNodeData
  findCard(id: string): { readonly workspaceId: string; readonly node: BrowserNodeData } | null
  /** Point the card at this address under this name, and let its old device go. */
  readdress(node: BrowserNodeData, url: string, name: string): Promise<BrowserNodeData>
  now?: () => number
  newId?: () => string
}

export type UseSourceAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly error: string }

export interface UseSourceService {
  list(workspaceId: string): Promise<UseSourceAnswer<UseSourceList>>
  /** `pick` is whatever the client sent. */
  open(workspaceId: string, pick: unknown): Promise<UseSourceAnswer<{ card: UseSourceCard }>>
  openSettings(workspaceId: string): Promise<UseSourceAnswer<null>>
}

export const NO_SOURCE = 'This machine has no way to share a window or a screen yet'
/** Not "closed": a window that left the list may be minimised, or on another Space. */
export const NOT_LISTED = 'That window is no longer in the list — pick another'
const refused = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })

const cardOf = (source: UseSource, id: string, tabId: string): BrowserNodeData => ({
  kind: 'browser',
  id,
  name: cardNameOf(source),
  url: source.address,
  tabs: [{ id: tabId, url: source.address, title: '' }],
  activeTabId: tabId,
  position: { x: 0, y: 0 },
  size: { width: 720, height: 560 }
})

const parsePick = (pick: unknown): { source: string; card: string | null } | null => {
  if (typeof pick !== 'object' || pick === null) return null
  const { source, card } = pick as { source?: unknown; card?: unknown }
  if (!isUseSourceId(source)) return null
  if (card !== undefined && (typeof card !== 'string' || card.length === 0 || card.length > 128)) return null
  return { source, card: card ?? null }
}

const summary = (card: BrowserNodeData): UseSourceCard => ({ id: card.id, name: card.name, url: card.url })

/** A source that fails is an answer in words, on every route: nothing here rejects. */
const answering = async <T>(work: () => Promise<UseSourceAnswer<T>>): Promise<UseSourceAnswer<T>> => {
  try {
    return await work()
  } catch (error) {
    return refused(500, error instanceof Error ? error.message : String(error))
  }
}

export function createUseSourceService(deps: UseSourceServiceDeps): UseSourceService {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  let inFlight: Promise<UseSourceList> | null = null
  let last: { at: number; list: UseSourceList } | null = null

  const gate = (workspaceId: string): string | null =>
    deps.servedWorkspace(workspaceId) ? servedUseRefusal(['sources'], () => []) : null

  const read = (freshMs: number): Promise<UseSourceList> => {
    if (last && now() - last.at < freshMs) return Promise.resolve(last.list)
    if (inFlight) return inFlight
    const provider = deps.provider()
    if (!provider) return Promise.resolve(emptySourceList('unavailable', NO_SOURCE))
    const reading = withDeadline(provider.list(), USE_SOURCES_LIST_MS, "this machine's screen").then((list) => {
      last = { at: now(), list }
      return list
    }).finally(() => {
      inFlight = null
    })
    inFlight = reading
    return reading
  }

  /** The card a pick points at, or the reason it may not be touched. */
  const targetCard = (workspaceId: string, id: string): BrowserNodeData | { status: number; error: string } => {
    const found = deps.findCard(id)
    if (!found) return { status: 404, error: 'That card is not in this workspace' }
    const refusal = gate(found.workspaceId)
    if (refusal) return { status: 403, error: refusal }
    if (found.workspaceId !== workspaceId) return { status: 404, error: 'That card is not in this workspace' }
    if (!parseUseUrl(activeBrowserTab(found.node).url)) return { status: 400, error: 'That card shows a web page, not a screen' }
    return found.node
  }

  /** What may be done right now: asked again after any wait, because a wait is when this changes. */
  const standing = (workspaceId: string, cardId: string | null): { card: BrowserNodeData | null } | { status: number; error: string } => {
    const refusal = gate(workspaceId)
    if (refusal) return { status: 403, error: refusal }
    if (cardId === null) return { card: null }
    const card = targetCard(workspaceId, cardId)
    return 'error' in card ? card : { card }
  }

  return {
    list: (workspaceId) =>
      answering(async () => {
        const refusal = gate(workspaceId)
        if (refusal) return refused(403, refusal)
        return { ok: true, value: await read(USE_SOURCES_FRESH_MS) }
      }),

    open: (workspaceId, raw) =>
      answering(async () => {
        const refusal = gate(workspaceId)
        if (refusal) return refused(403, refusal)
        const pick = parsePick(raw)
        if (!pick) return refused(400, 'Pick a window or a screen from the list')
        const before = standing(workspaceId, pick.card)
        if ('error' in before) return refused(before.status, before.error)
        const list = await read(PICK_FRESH_MS)
        const now = standing(workspaceId, pick.card)
        if ('error' in now) return refused(now.status, now.error)
        if (list.state !== 'ready') return refused(409, list.message ?? NO_SOURCE)
        const source = [...list.windows, ...list.screens].find((s) => s.id === pick.source)
        if (!source) return refused(404, NOT_LISTED)
        if (now.card) return { ok: true, value: { card: summary(await deps.readdress(now.card, source.address, cardNameOf(source))) } }
        return { ok: true, value: { card: summary(deps.addCard(workspaceId, cardOf(source, newId(), newId()))) } }
      }),

    openSettings: (workspaceId) =>
      answering(async () => {
        const refusal = gate(workspaceId)
        if (refusal) return refused(403, refusal)
        await deps.provider()?.openSettings()
        return { ok: true, value: null }
      })
  }
}
