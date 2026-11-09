// THE WRIST'S ROUTES.
//
// A watch token is not a pairing token with a smaller name: it opens the list
// below and nothing else. What is on the list is what a card offers on a phone
// — read the cards, send words, answer a menu, stop a turn, see and tap a
// browser — and every write goes through the path the phone's write takes
// (the closed input vocabulary, the menu answerer, /input's submit primitive).
//
// mobile-api.ts asks watchRouteAllowed at its one gate, so an allowed route
// keeps every check that route already had, and a route not listed is a 401
// exactly as for no token at all.

import { createHash } from 'node:crypto'
import type http from 'node:http'
import { sanitizeInput, sanitizePaste } from '../shared/cast-input'
import { closingMessage } from '../shared/trace-blocks'
import type { BoardSnapshot } from './board-index'
import type { BrowserInstance } from './browser-instance'
import type { StreamService } from './stream-service'
import { readJson, respondJson } from './mobile-http'
import type { TerminalActivity } from '../shared/turn'
import type { LatestCheckpoint } from '../renderer/src/turn-view-model'
import { crewRows, itemsOfAgent, MAX_CREW, rowsOfWorkspace, watchCards, watchWorkspaces, type WatchCard, type WatchItem, type WatchWorkspace } from './watch-cards'
import type { WatchPairing } from './watch-pairing'

/** A frame as wide as the widest watch at 2x; a phone's is not needed on a wrist. */
export const FRAME_WIDTH_DEFAULT = 416
const FRAME_WIDTH_MIN = 120
const FRAME_WIDTH_MAX = 640
/** The most one swipe scrolls, in screens. */
const SCROLL_SHARE_MAX = 3
/** Most of a note a wrist is sent. */
const NOTE_MAX = 8000
/** Words for a new agent, as a person says them. */
const NEW_AGENT_MAX = 4000

const ALLOWED: readonly (readonly [string, RegExp])[] = [
  ['GET', /^\/api\/watch\/(me|cards)$/],
  ['GET', /^\/api\/watch\/item\/[^/]+(\/frame)?$/],
  ['POST', /^\/api\/watch\/item\/[^/]+\/input$/],
  ['POST', /^\/api\/watch\/card\/[^/]+\/stop$/],
  ['POST', /^\/api\/watch\/(new|unpair)$/],
  // The phone's own routes, whole: the same submit, the same menu check.
  ['POST', /^\/api\/terminal\/[^/]+\/(input|menu|seen)$/]
]

/** May a watch token open this? Everything else answers as if it were no token. */
export function watchRouteAllowed(method: string, pathname: string): boolean {
  return ALLOWED.some(([allowed, route]) => allowed === method && route.test(pathname))
}

/** Where a watch can reach this Mac. */
export interface WatchBase {
  readonly kind: 'lan' | 'tailnet' | 'name'
  readonly url: string
}

/** What a sheet must ask for before a join code can be minted. */
export type WatchAccountKind = 'none' | 'password' | 'passwordless'

/** A join code for a watch, or why not, in the registry's reason words. */
export type WatchInvite =
  | { readonly ok: true; readonly code: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string; readonly message?: string }

/** What a sheet is given: a code comes with the count of arrivals it is to be measured from. */
export type WatchInviteReply = Exclude<WatchInvite, { ok: true }> | (Extract<WatchInvite, { ok: true }> & { readonly claims: number })

/** What main lends these routes (index.ts); a module seam, as setMenuAnswerer is. */
export interface WatchHost {
  readonly pairing: WatchPairing
  desktopName(): string
  bases(): readonly WatchBase[]
  /** The workspace's canvas, for an agent's items. */
  canvas(workspaceId: string): Parameters<typeof itemsOfAgent>[1]
  /** The picture of a browser card, at most `width` wide. */
  /** A wrist touched this page: its picture is about to change (pageSettler). */
  moved?(browserId: string): void
  /** A browser's picture. A peek is a thumbnail's: the picture the Mac already has, and no browser started for it. */
  frame(browserId: string, width: number, peek: boolean): Promise<{ type: string; data: Buffer } | null>
  browser(browserId: string): Promise<BrowserInstance | null>
  note(noteId: string): { name: string; content: string } | null
  /** Make a new agent from the words, as the prompt box does; its id. */
  makeAgent(words: string): Promise<string>
  /** The Esc byte to a terminal; false when nothing is running there. */
  stop(terminalId: string): Promise<boolean>
  /** An agent, not a bare shell: words typed into a shell are commands. */
  speaksTo(terminalId: string): boolean
  /** A menu is on its screen, read or not: words and Enter would pick the cursor row. */
  menuOnScreen(terminalId: string): boolean
  /** This Mac's workspaces, in its own order. */
  workspaces(): readonly { readonly id: string; readonly name: string }[]
  accountKind(): WatchAccountKind
  /** Mint a join code under this password. `here`: asked on this Mac, where a provider trip can open. */
  invite(current: string, here: boolean): Promise<WatchInvite>
}

let host: WatchHost | null = null

export function setWatchHost(next: WatchHost | null): void {
  host = next
}

/**
 * A code for a watch: the account's join code, armed here as the claim too, so
 * one code carries the watch into the account and on to this Mac. The registry
 * spends it at the join, which is why this Mac must hold its own copy.
 */
export async function inviteWatch(current: Pick<WatchHost, 'invite' | 'pairing'>, password: string, here: boolean): Promise<WatchInviteReply> {
  try {
    const invite = await current.invite(password, here)
    if (!invite.ok) return invite
    current.pairing.arm(invite.code, invite.expiresAt)
    return { ...invite, claims: current.pairing.claims }
  } catch (error) {
    console.error('Minting a code for the watch failed:', error)
    return { ok: false, reason: 'unknown' }
  }
}

export const watchTokenAccepted = (candidate: string | null): boolean => host?.pairing.accepts(candidate) ?? false

const TERMINAL_WRITE = /^\/api\/terminal\/([^/]+)\/(input|menu)$|^\/api\/watch\/card\/([^/]+)\/stop$/

/**
 * What a watch may not do even on a route of its list, as a refusal; null when
 * it may. Asked at the gate, only for a watch token, so the phone's own use of
 * these routes is untouched.
 *
 *   A shell is out of reach: a watch's words go to agents. A token lifted off
 *   a wrist must not be a command line on this Mac.
 *   /input into a menu is held: the words and their Enter would pick the row
 *   under the cursor, which on a question nobody parsed may be "Yes". /menu,
 *   which names its row, is how a menu is answered.
 */
export function watchWriteRefusal(path: string): { status: number; error: string } | null {
  const write = path.match(TERMINAL_WRITE)
  if (!write || !host) return null
  const id = decodeURIComponent(write[1] ?? write[3])
  if (!host.speaksTo(id)) return { status: 403, error: 'A watch does not type into a shell.' }
  if (write[2] === 'input' && host.menuOnScreen(id)) return { status: 409, error: 'A menu is up: answer it on the Mac.' }
  return null
}

export interface WatchRequest {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly url: URL
  readonly method: string
  readonly path: string
  /** The owner's own pairing, not a watch's. */
  readonly owner: boolean
  /** A pairing or a watch token. The wall's read-only token is neither: it reads no card here. */
  readonly cleared: boolean
  /** Encrypted on the way here (mobile-api.ts · sealedTransport): a password may arrive on it. */
  sealed(): boolean
  /** `wide`: a week of rows, for one workspace's whole crew rather than the day's. */
  board(wide?: boolean): Promise<BoardSnapshot>
  activities(): readonly TerminalActivity[]
  checkpoint(terminalId: string): Promise<LatestCheckpoint | null>
  /** Still a member of the crew (the registry): a closed agent reads asleep. */
  active(agentId: string): boolean
}

/**
 * The one unauthenticated route: six digits for a token. Answered ahead of the
 * gate, as /api/auth/status is. Open means rate-limited, not unguarded
 * (watch-pairing.ts).
 */
export async function handleWatchClaim(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  method: string,
  path: string
): Promise<boolean> {
  if (method !== 'POST' || path !== '/api/watch/claim' || !host) return false
  const body = await readJson<{ code?: unknown }>(request)
  const claim = host.pairing.claim(body.code)
  if (!claim.ok) {
    respondJson(response, claim.reason === 'paused' ? 429 : 403, { ok: false, reason: claim.reason })
    return true
  }
  respondJson(response, 200, { ok: true, token: claim.token, desktop: host.desktopName(), bases: host.bases() })
  return true
}

/** Long enough to be unguessable, short enough to sign without thinking. */
const HELLO_NONCE = /^[A-Za-z0-9_-]{16,64}$/

/**
 * Open, like the claim: a watch asks this before its token goes anywhere near a
 * plain-HTTP address. It answers only with a signature, so it gives away nothing
 * but that a watch is paired here.
 */
export function handleWatchHello(response: http.ServerResponse, url: URL, method: string, path: string): boolean {
  if (method !== 'GET' || path !== '/api/watch/hello' || !host) return false
  const nonce = url.searchParams.get('n') ?? ''
  if (!HELLO_NONCE.test(nonce)) {
    respondJson(response, 400, { error: 'A hello needs a nonce.' })
    return true
  }
  const proof = host.pairing.proof(nonce)
  if (proof === null) respondJson(response, 404, { error: 'No watch is paired here.' })
  else respondJson(response, 200, { proof })
  return true
}

/**
 * An agent's last turn, as a card says it: the words the turn ENDED on. A block's
 * `reply` joins every message of the turn, and its first line is the turn's
 * opening narration (owner, 2026-11-04), so /latest will not do for a card.
 * The old reader is the fallback for a card the stream does not know.
 */
export async function cardCheckpoint(
  terminalId: string,
  stream: Pick<StreamService, 'sourceOf' | 'tailState' | 'marks'> | undefined,
  latest: ((terminalId: string) => Promise<LatestCheckpoint | null>) | undefined
): Promise<LatestCheckpoint | null> {
  if (stream?.sourceOf(terminalId)) {
    const { block } = await stream.tailState(terminalId)
    if (block) {
      const title = stream.marks(terminalId).get(block.id)?.title
      return { prompt: block.prompt, reply: closingMessage(block), ...(title !== undefined ? { title } : {}) }
    }
  }
  return latest ? latest(terminalId) : null
}

/**
 * How long a card's last turn is believed. A poll must not read a transcript
 * tail per card, and the board's time cannot key this: an agent with no mirror
 * here has a new reply in its transcript long before its row moves.
 */
export const CHECKPOINT_MEMO_MS = 8000

const checkpointMemo = new Map<string, { readAt: number; checkpoint: LatestCheckpoint | null }>()

export async function checkpointsOf(
  rows: readonly { terminalId: string }[],
  live: ReadonlyMap<string, TerminalActivity>,
  read: WatchRequest['checkpoint'],
  now: number = Date.now(),
  memo: Map<string, { readAt: number; checkpoint: LatestCheckpoint | null }> = checkpointMemo
): Promise<Map<string, LatestCheckpoint | null>> {
  const found = new Map<string, LatestCheckpoint | null>()
  await Promise.all(
    rows.map(async (row) => {
      if (live.get(row.terminalId)?.reply) return
      const known = memo.get(row.terminalId)
      if (known && now - known.readAt < CHECKPOINT_MEMO_MS) return void found.set(row.terminalId, known.checkpoint)
      try {
        const checkpoint = await read(row.terminalId)
        memo.set(row.terminalId, { readAt: now, checkpoint })
        found.set(row.terminalId, checkpoint)
      } catch {
        // Not remembered: the next poll reads again.
        found.set(row.terminalId, known?.checkpoint ?? null)
      }
    })
  )
  return found
}

const tagOf = (data: string | Buffer): string => `"${createHash('sha1').update(data).digest('base64url')}"`

/** A body the watch already has answers 304: most polls of a quiet crew cost a header. */
function respondTagged(ctx: WatchRequest, type: string, data: string | Buffer): void {
  const tag = tagOf(data)
  if (ctx.request.headers['if-none-match'] === tag) {
    ctx.response.writeHead(304, { etag: tag, 'cache-control': 'no-store' })
    ctx.response.end()
    return
  }
  ctx.response.writeHead(200, { 'content-type': type, etag: tag, 'cache-control': 'no-store' })
  ctx.response.end(data)
}

/** A workspace id as a wrist may ask for one. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/

async function cards(
  ctx: WatchRequest,
  current: WatchHost,
  workspaceId: string | null
): Promise<{ cards: WatchCard[]; activeWorkspaceId: string; workspaces: WatchWorkspace[] }> {
  // Inside a workspace the wrist shows its whole crew, so the week and not the day.
  const board = await ctx.board(workspaceId !== null)
  const canvases = new Map<string, ReturnType<WatchHost['canvas']>>()
  const canvasOf = (workspaceId: string): ReturnType<WatchHost['canvas']> => {
    const known = canvases.get(workspaceId)
    if (known) return known
    const canvas = current.canvas(workspaceId)
    canvases.set(workspaceId, canvas)
    return canvas
  }
  // Inside a workspace: its whole crew, the agents the board has no row for too.
  const named = workspaceId === null ? null : current.workspaces().find((w) => w.id === workspaceId)
  const rows =
    workspaceId === null
      ? board.rows
      : crewRows(canvasOf(workspaceId).nodes, board.rows, {
          id: workspaceId,
          name: named?.name ?? rowsOfWorkspace(board.rows, workspaceId)[0]?.workspace.name ?? '',
          active: workspaceId === board.activeWorkspaceId
        })
  const activities = new Map(ctx.activities().map((activity) => [activity.terminalId, activity]))
  const checkpoints = await checkpointsOf(rows, activities, ctx.checkpoint)
  return {
    cards: watchCards({
      rows,
      activities,
      checkpoints,
      active: ctx.active,
      itemsOf: (agentId, workspaceId) => itemsOfAgent(agentId, canvasOf(workspaceId)),
      ...(workspaceId === null ? {} : { limit: MAX_CREW })
    }),
    activeWorkspaceId: board.activeWorkspaceId,
    workspaces: watchWorkspaces({
      workspaces: current.workspaces(),
      activeId: board.activeWorkspaceId,
      rows: board.rows,
      agentsIn: (id) => canvasOf(id).nodes.filter((node) => node.kind === 'terminal').length,
      active: ctx.active
    })
  }
}

/** Browser input as a wrist makes it: points are fractions of the picture, so no frame size crosses the wire. */
export function browserInputOf(body: Record<string, unknown>, viewport: { width: number; height: number }): Record<string, unknown> | null {
  const fraction = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null)
  switch (body.t) {
    case 'tap': {
      const x = fraction(body.x)
      const y = fraction(body.y)
      return x === null || y === null ? null : { t: 'tap', x: x * viewport.width, y: y * viewport.height }
    }
    case 'scroll': {
      // A swipe says its distance as a share of the picture's height (fy), which only
      // the Mac can turn into pixels; a crown says pixels (dy). It lands where the finger was.
      const share = typeof body.fy === 'number' && Number.isFinite(body.fy) ? Math.max(-SCROLL_SHARE_MAX, Math.min(SCROLL_SHARE_MAX, body.fy)) : null
      const dy = share !== null ? share * viewport.height : typeof body.dy === 'number' && Number.isFinite(body.dy) ? body.dy : null
      if (dy === null) return null
      return { t: 'wheel', x: (fraction(body.x) ?? 0.5) * viewport.width, y: (fraction(body.y) ?? 0.5) * viewport.height, dy }
    }
    case 'enter':
      return { t: 'key', key: 'Enter', code: 'Enter' }
    default:
      return null
  }
}

async function itemInput(ctx: WatchRequest, current: WatchHost, id: string): Promise<void> {
  const instance = await current.browser(id)
  if (!instance) return respondJson(ctx.response, 404, { error: 'That browser is not open.' })
  // A computer's screen is taken from a device that watches it, never from a wrist.
  if (instance.needsViewer) return respondJson(ctx.response, 409, { error: 'That screen is view only here.' })
  const state = instance.viewportState
  if (state.transitioning || state.agentHeld) return respondJson(ctx.response, 409, { error: 'An agent is driving that browser.' })
  const body = await readJson<Record<string, unknown>>(ctx.request)
  const pasted = body.t === 'text' ? sanitizePaste({ t: 'paste', text: body.text }) : null
  if (pasted !== null) {
    if (instance.paste) await instance.paste(pasted)
    else await instance.dispatchInput('Input.insertText', { text: pasted })
    current.moved?.(id)
    return respondJson(ctx.response, 200, { ok: true })
  }
  const message = browserInputOf(body, state)
  const commands = message && sanitizeInput(message, { displayScale: 1, viewportWidth: state.width, viewportHeight: state.height })
  if (!commands) return respondJson(ctx.response, 400, { error: 'Not an input a watch sends.' })
  for (const command of commands) await instance.dispatchInput(command.method, command.params)
  current.moved?.(id)
  respondJson(ctx.response, 200, { ok: true })
}

/** How long after a wrist's touch the page is photographed: long enough for it to have moved. */
export const SETTLE_MS = 450

/**
 * ONE FRESH PICTURE AFTER A WRIST TOUCHES A PAGE. The Mac otherwise photographs
 * a page at most every few seconds, so a tap's result would reach the wrist late.
 * A crown turning touches the page four times a second: those make one picture
 * per SETTLE_MS, per page, and only for a wrist's touches, so a phone or the
 * desktop working the same page pays nothing it did not before.
 */
export function pageSettler(take: (browserId: string) => unknown, delayMs: number = SETTLE_MS): (browserId: string) => void {
  const waiting = new Set<string>()
  return (browserId) => {
    if (waiting.has(browserId)) return
    waiting.add(browserId)
    const timer = setTimeout(() => {
      waiting.delete(browserId)
      // A picture that fails waits for the next touch, or the page's own pace.
      try {
        void Promise.resolve(take(browserId)).catch(() => undefined)
      } catch {
        return
      }
    }, delayMs)
    timer.unref?.()
  }
}

/** Every /api/watch route past the gate; false for anything else. */
export async function handleWatchRoutes(ctx: WatchRequest): Promise<boolean> {
  const { method, path, response } = ctx
  if (!path.startsWith('/api/watch/')) return false
  const current = host
  if (!current) {
    respondJson(response, 503, { error: 'watch not wired' })
    return true
  }
  if (!ctx.cleared) {
    respondJson(response, 401, { error: 'Unauthorized' })
    return true
  }

  if (ctx.owner && method === 'POST' && path === '/api/watch/code') {
    respondJson(response, 200, { ...current.pairing.mintCode(), bases: current.bases(), claims: current.pairing.claims })
    return true
  }
  if (ctx.owner && method === 'GET' && path === '/api/watch/pairing') {
    respondJson(response, 200, { paired: current.pairing.paired, pending: current.pairing.pending(), account: current.accountKind(), sealed: ctx.sealed(), claims: current.pairing.claims })
    return true
  }
  if (ctx.owner && method === 'POST' && path === '/api/watch/invite') {
    if (!ctx.sealed()) {
      respondJson(response, 200, { ok: false, reason: 'not_sealed' })
      return true
    }
    const body = await readJson<{ current?: unknown }>(ctx.request)
    respondJson(response, 200, await inviteWatch(current, typeof body.current === 'string' ? body.current : '', false))
    return true
  }
  if (method === 'POST' && path === '/api/watch/unpair') {
    current.pairing.unpair()
    respondJson(response, 200, { ok: true })
    return true
  }
  if (method === 'GET' && path === '/api/watch/me') {
    respondJson(response, 200, { desktop: current.desktopName(), bases: current.bases() })
    return true
  }
  if (method === 'GET' && path === '/api/watch/cards') {
    const asked = ctx.url.searchParams.get('workspace')
    if (asked !== null && !WORKSPACE_ID.test(asked)) {
      respondJson(response, 400, { error: 'Not a workspace.' })
      return true
    }
    respondTagged(ctx, 'application/json', JSON.stringify(await cards(ctx, current, asked)))
    return true
  }
  if (method === 'POST' && path === '/api/watch/new') {
    const body = await readJson<{ text?: unknown }>(ctx.request)
    const words = typeof body.text === 'string' ? body.text.trim() : ''
    if (!words || words.length > NEW_AGENT_MAX) {
      respondJson(response, 400, { error: 'A new agent needs words to start from.' })
      return true
    }
    try {
      respondJson(response, 200, { ok: true, id: await current.makeAgent(words) })
    } catch (error) {
      respondJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  const stop = path.match(/^\/api\/watch\/card\/([^/]+)\/stop$/)
  if (stop && method === 'POST') {
    const stopped = await current.stop(decodeURIComponent(stop[1]))
    respondJson(response, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'Terminal not running' })
    return true
  }

  const item = path.match(/^\/api\/watch\/item\/([^/]+)(?:\/(frame|input))?$/)
  if (!item) return false
  const id = decodeURIComponent(item[1])
  if (method === 'POST' && item[2] === 'input') {
    await itemInput(ctx, current, id)
    return true
  }
  if (method === 'GET' && item[2] === 'frame') {
    const asked = Number(ctx.url.searchParams.get('w'))
    const width = Number.isFinite(asked) && asked > 0 ? Math.min(FRAME_WIDTH_MAX, Math.max(FRAME_WIDTH_MIN, Math.round(asked))) : FRAME_WIDTH_DEFAULT
    const frame = await current.frame(id, width, ctx.url.searchParams.get('peek') === '1')
    if (!frame) respondJson(response, 404, { error: 'No picture yet' })
    else respondTagged(ctx, frame.type, frame.data)
    return true
  }
  if (method === 'GET' && item[2] === undefined) {
    const note = current.note(id)
    if (!note) respondJson(response, 404, { error: 'No such note' })
    else respondJson(response, 200, { name: note.name, content: note.content.slice(0, NOTE_MAX) })
    return true
  }
  return false
}

export type { WatchItem }
