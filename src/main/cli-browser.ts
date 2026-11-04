// `cookrew browser …` when the engine is node-owned headless Chrome.
//
// Owner ruling 2026-11-04: every workspace works on its own; switching what
// the window shows never stops, refuses or loses anything elsewhere. The
// headless engine holds its pages in main, so nothing here asks which canvas
// is on screen: a name resolves for the CALLER (browser-reach.ts) and a new
// card goes to the caller's own workspace. The renderer engine (webviews,
// mounted only for the canvas on screen) keeps the focus-scoped path in
// socket-server.ts · cmdBrowser, because there the page really does exist
// only where the window looks.
import type { BrowserNodeData, CliRequest, TerminalNodeData } from '../shared/model'
import { browserVerbKind } from '../shared/cable-signal'
import { servedUseRefusal } from './use-commands'
import { browserForCaller, type BrowserReachStore } from './browser-reach'

export interface ScopedBrowserContext {
  me: TerminalNodeData
  args: string[]
  flags: CliRequest['flags']
  store: BrowserReachStore
  served: boolean
  /** Where a new card goes — the caller's own workspace, or a refusal (cliWorkspaceScope). */
  createScope: () => { id: string; name: string }
  browserCommand: (args: string[], terminalId: string) => Promise<string>
  /**
   * A stored card in a named workspace, for a caller no workspace holds (a
   * registry-only identity): it has no home for the engine to place it in.
   */
  createElsewhere?: (card: { url: string; name: string; terminalId: string; workspaceId: string }) => {
    name: string
    adopted: boolean
  }
  /** Lay the cable an inquiry made, attributed to the caller and the verb. */
  wire: (otherId: string, via: string) => void
  signal?: (moment: { from: string; to: string; kind: 'write' | 'read' }) => void
}

export async function cmdBrowserScoped(ctx: ScopedBrowserContext): Promise<string> {
  const [sub, name] = ctx.args
  const find = (cardName: string) => browserForCaller(ctx.store, ctx.me.id, cardName, ctx.served)
  // A served caller never reaches the owner's screens, cameras or phones
  // (use-commands.ts · servedUseRefusal) — checked before anything runs.
  if (ctx.served) {
    const refusal = servedUseRefusal(ctx.args, (cardName) => {
      const card = find(cardName)?.node
      return card ? (card.tabs ?? []).map((tab) => tab.url).concat(card.url) : []
    })
    if (refusal) throw new Error(refusal)
  }
  if (sub === 'create') return create(ctx)

  // Resolved BEFORE the verb runs: the card wired and signalled is the card
  // the engine was asked to drive, whatever the page does to its card while
  // the command is in flight (a rename, a title-driven move).
  const kind = browserVerbKind(sub ?? '')
  const hit = kind && name ? find(name) : null
  const result = await ctx.browserCommand(ctx.args, ctx.me.id)
  // The cable lights once the verb has run: driving the page is agent →
  // browser, reading it is browser → agent (shared/cable-signal browserVerbKind).
  if (kind && hit) {
    // Driving a page of your own canvas wires you to it — on screen or not.
    const own = hit.workspaceId === ctx.store.ownerOf(ctx.me.id)
    if (own && !ctx.served && !isWired(ctx, hit.node.id)) ctx.wire(hit.node.id, `browser ${sub}`)
    ctx.signal?.(
      kind === 'write' ? { from: ctx.me.id, to: hit.node.id, kind } : { from: hit.node.id, to: ctx.me.id, kind }
    )
  }
  return result
}

/**
 * A DELIVERABLE WITH THE SAME NAME IS THE SAME DELIVERABLE: a name already on
 * the caller's canvas is adopted (wired, navigated when the URL differs)
 * unless --new. Otherwise the engine makes it in the caller's workspace and
 * starts its page now — not "when that workspace is shown".
 */
async function create(ctx: ScopedBrowserContext): Promise<string> {
  const scope = ctx.createScope()
  const [, url, requestedName] = ctx.args
  if (!url) throw new Error('Usage: cookrew browser create URL ["Name"] [--workspace <name>] [--new]')
  const homeless = ctx.store.ownerOf(ctx.me.id) === undefined
  // A caller no workspace holds has no canvas for the engine to place a card
  // on: a workspace it names gets a stored card, exactly as before.
  if (homeless && scope.id !== ctx.store.focusedId) {
    if (!ctx.createElsewhere) throw new Error(`This build cannot make a card in "${scope.name}".`)
    const made = ctx.createElsewhere({ url, name: requestedName || 'Browser', terminalId: ctx.me.id, workspaceId: scope.id })
    return (
      `Created browser "${made.name}" in workspace "${scope.name}"` +
      (made.adopted ? ' (it was already there — navigated)' : ' — it opens when that workspace is shown')
    )
  }
  if (requestedName && !ctx.flags.new) {
    const wanted = requestedName.toLowerCase()
    const existing = ctx.store
      .workspaceState(scope.id)
      .nodes.find((n): n is BrowserNodeData => n.kind === 'browser' && n.name.toLowerCase() === wanted)
    if (existing) {
      const wired = isWired(ctx, existing.id)
      // A caller held by no workspace owns no edge (it is a node nowhere).
      if (!wired && !homeless) ctx.wire(existing.id, 'browser create')
      const navigated = url !== existing.url
      if (navigated) await ctx.browserCommand(['navigate', existing.name, url], ctx.me.id)
      return (
        `Browser "${existing.name}" already exists in "${scope.name}"` +
        ` — ${wired ? 'already wired to you' : homeless ? 'not wired: your terminal is not a card' : 'now wired to you'}` +
        (navigated ? `, navigated to ${url}` : '') +
        '. Pass --new to create a second one.'
      )
    }
  }
  return ctx.browserCommand(ctx.args, ctx.me.id)
}

function isWired(ctx: ScopedBrowserContext, nodeId: string): boolean {
  return (ctx.store.connectedToAcross?.(ctx.me.id) ?? []).some((hit) => hit.node.id === nodeId)
}
