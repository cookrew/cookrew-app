/**
 * Split a request path into workspace scope and remainder.
 *
 * Step 3 of the multi-instance refactor (marketplace-architecture §11):
 * https://<host>/<slug>/api/* addresses ONE workspace session, so two phones
 * can read two canvases at once and a desktop focus change stops re-pointing
 * every seat in the building. /<slug>/agents/<name>/ask is the same mount,
 * which is what §9's remote calls land on.
 *
 * Unslugged paths are returned untouched and keep their existing meaning —
 * bound to the focused session. That is not a transition measure: every paired
 * phone holds a bookmark to `/`, so this step is additive or it is a
 * regression.
 *
 * Pure and total. A first segment that is not exactly the shape deriveSlug
 * mints is NOT a scope — a path-traversal segment must never be able to
 * address another workspace's routes, so the shape is allow-listed rather than
 * sanitised.
 */

/** Exactly what workspace-slug.ts mints: lowercase alnum plus inner hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// One list, shared with the minting side — see workspace-slug.ts for why
// `src` and `node_modules` are on it.
import { RESERVED_SLUGS } from './workspace-slug'

export interface SlugRoute {
  /** Workspace scope, or null for the unslugged (focused-session) routes. */
  slug: string | null
  /** The path as the existing handlers expect to see it. */
  pathname: string
}

export function splitSlugRoute(pathname: string): SlugRoute {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/)
  if (!match) return { slug: null, pathname }

  const [, first, rest] = match
  if (RESERVED_SLUGS.has(first) || !SLUG.test(first)) return { slug: null, pathname }

  // A bare /<slug> is that workspace's index, same as / is the focused one's.
  const remainder = rest === undefined || rest === '/' ? '/' : rest
  return { slug: first, pathname: remainder }
}

/** What a request path resolves to once the slug is looked up. */
export type ScopedRoute =
  | { kind: 'unscoped'; pathname: string }
  | { kind: 'scoped'; workspaceId: string; slug: string; pathname: string }
  | { kind: 'unknown-slug'; slug: string }

/**
 * Resolve a path to the workspace session that should answer it.
 *
 * An unknown slug is its OWN outcome, never a fallback to focus: serving a
 * different workspace than the URL names is the confusion slugs exist to end,
 * and a phone that gets a canvas back has no way to tell it asked for the
 * wrong one. The router answers it 404.
 */
export function resolveScopedRoute(
  pathname: string,
  workspaceIdOfSlug: (slug: string) => string | undefined
): ScopedRoute {
  const route = splitSlugRoute(pathname)
  if (route.slug === null) return { kind: 'unscoped', pathname: route.pathname }

  const workspaceId = workspaceIdOfSlug(route.slug)
  if (workspaceId === undefined) return { kind: 'unknown-slug', slug: route.slug }
  return { kind: 'scoped', workspaceId, slug: route.slug, pathname: route.pathname }
}

/**
 * May a scoped request address this node?
 *
 * Unscoped requests keep their existing reach (the focused session, as
 * before). A scoped one may only touch nodes its own workspace owns —
 * otherwise the slug is decoration and
 * /playground/api/terminal/<id-from-another-workspace> drives a terminal the
 * URL does not name.
 */
export function nodeInScope(
  scope: string | null,
  ownerOfNode: string | undefined
): boolean {
  return scope === null || ownerOfNode === scope
}

/**
 * Routes verified to honour a workspace scope.
 *
 * mobile-api serves ~44 routes and answers all but a handful for the FOCUSED
 * session regardless of path. Making a slug reach them before they are
 * scope-aware would be worse than not having slugs: POST
 * /playground/api/terminal/<id-from-another-workspace>/raw would drive a
 * terminal the URL does not name, and /playground/api/workspace would return
 * a different canvas than the one asked for, with nothing to tell the caller.
 *
 * So the scoped surface is an ALLOW-LIST and everything else under a slug is
 * refused. The list grows one route at a time as each is threaded through the
 * scope; until then the honest answer is "not here yet", not a wrong answer
 * that looks right.
 */
/**
 * Routes addressed by a NODE ID, and therefore safe to scope by membership.
 *
 * These act on one node — write to its pty, resize it, stream it, read its
 * turns — so once nodeInScope confirms the node belongs to the scoped
 * workspace, the handler acting by id is correct by construction. That is what
 * separates them from /api/workspace, which answers for FOCUS whatever the
 * path says and cannot be scoped by a membership check alone.
 *
 * ONE table, because SCOPE_AWARE and nodeIdOfRoute used to be two independent
 * regexes: adding a route to the allow-list without teaching the extractor
 * would let it through UNGATED — a slugged URL driving a node in another
 * workspace, which is exactly the decoration the scope check exists to
 * prevent. Derived from one source, they cannot drift.
 *
 * DELIBERATELY ABSENT: /fork. It creates a NEW terminal, and placement is a
 * workspace decision rather than a property of the addressed node, so a
 * membership check on the source does not establish where the fork lands.
 * It stays 501 under a slug until that placement is verified scope-aware.
 */
export const NODE_ROUTES: RegExp[] = [
  // Live seat: keystrokes, geometry, pane content. Without raw a slugged
  // phone cannot TYPE, which is the gap Magpie found — a seat that cannot
  // type is not a seat, and §11 promises a companion on a slug is one.
  /^\/api\/terminal\/[^/]+\/raw$/,
  /^\/api\/terminal\/[^/]+\/resize$/,
  /^\/api\/terminal\/[^/]+\/stream$/,
  // Submit paths (already scoped before this change).
  /^\/api\/terminal\/[^/]+\/(?:input|ask)$/,
  /^\/api\/terminal\/[^/]+\/output$/,
  // Reading and navigating the transcript.
  /^\/api\/terminal\/[^/]+\/jump$/,
  /^\/api\/terminal\/[^/]+\/seen$/,
  /^\/api\/terminal\/[^/]+\/turns(?:\?.*)?$/,
  /^\/api\/terminal\/[^/]+\/trace(?:\?.*)?$/,
  /^\/api\/terminal\/[^/]+\/trace\/index$/,
  /^\/api\/terminal\/[^/]+\/trace\/markers$/,
  // NOT /cwd. It reads as node-addressed, but its implementation is
  // focus-bound: moveTerminalCwd resolves through store.node() and validates
  // against store.focusedState.dirs, so a scoped call for a terminal in a
  // NON-focused workspace passes the membership gate and then answers 400
  // "Not a terminal node" for a terminal that plainly exists. That is the
  // /api/workspace shape this file's own doctrine disqualifies — answering for
  // focus whatever the path says — and allow-listing it would break the
  // "correct by construction" claim the rest of this table rests on. It fails
  // closed, so this is honesty rather than a hole; /cwd stays 501 under a slug
  // until moveTerminalCwd takes a workspace id. A seat needs to type, not to
  // move house. (Tinker review, 2026-08-22.)
  // Browser card picture.
  /^\/api\/browser\/[^/]+\/thumb$/
]

export const SCOPE_AWARE: RegExp[] = [
  // The renderer index, EARNED. It was refused while the bundled client
  // issued root-absolute /api/... requests, because serving it at /<slug>
  // rendered the FOCUSED canvas under a URL naming a different workspace. The
  // client is genuinely slug-aware now: mobile-server injects
  // window.COOKREW_SLUG into the boot script of both index paths and
  // api-base.ts prefixes every request with it, enforced by an exhaustive
  // conformance sweep (tests/api-base.test.ts).
  /^\/$/,
  /^\/index\.html$/,
  /^\/api\/state$/,
  // The canvas and the live stream — the two that make a scoped client real.
  // /api/events listens to the TAGGED per-workspace change signal when scoped,
  // so a desktop focus change no longer re-points a phone that arrived here.
  /^\/api\/workspace$/,
  /^\/api\/events$/,
  // Genuinely global, and safe to answer identically under any scope: the
  // workspace ROSTER (not a canvas), auth status, the preset catalogue, the
  // browser runtime capability flag, and git for a directory.
  /^\/api\/workspaces$/,
  /^\/api\/auth\/status$/,
  /^\/api\/presets$/,
  /^\/api\/git(?:\?.*)?$/,
  /^\/api\/browser\/capabilities$/,
  // Node-addressed seat routes, from the ONE table below.
  ...NODE_ROUTES
]

export function scopedRouteSupported(pathname: string): boolean {
  return SCOPE_AWARE.some((pattern) => pattern.test(pathname))
}

/**
 * Node id addressed by a scope-aware path, if it addresses one.
 *
 * Extracted at the choke point rather than per-route so a new scoped route
 * cannot forget its own scope check — forgetting is the failure mode this
 * whole refactor is written against.
 */
export function nodeIdOfRoute(pathname: string): string | null {
  // Only a path the NODE_ROUTES table claims may yield an id, so a route
  // cannot be allow-listed and left ungated, nor gated without being allowed.
  if (!NODE_ROUTES.some((pattern) => pattern.test(pathname))) return null
  const match = pathname.match(/^\/api\/(?:terminal|browser)\/([^/]+)\//)
  return match ? match[1] : null
}
