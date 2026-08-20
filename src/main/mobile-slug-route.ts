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

/** Prefixes the server owns; they can never be a workspace scope. */
const RESERVED = new Set(['api', 'assets', 'index.html'])

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
  if (RESERVED.has(first) || !SLUG.test(first)) return { slug: null, pathname }

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
const SCOPE_AWARE: RegExp[] = [
  // NOT the renderer index. The bundled client issues root-absolute /api/...
  // requests, so serving it at /<slug> would render the FOCUSED canvas under a
  // URL naming a different workspace — a wrong answer that looks right, which
  // is the whole thing this allow-list exists to prevent. Serving the client
  // per-slug needs the slug threaded to it (window.COOKREW_SLUG through
  // REMOTE_BOOT, remote-api.ts prefixing every request); until then a bare
  // /<slug> is refused rather than quietly lying.
  /^\/api\/state$/,
  /^\/api\/browser\/capabilities$/,
  /^\/api\/terminal\/[^/]+\/output$/,
  /^\/api\/terminal\/[^/]+\/(?:input|ask)$/,
  /^\/api\/browser\/[^/]+\/thumb$/
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
  const match = pathname.match(
    /^\/api\/(?:terminal|browser)\/([^/]+)\/(?:output|input|ask|thumb)$/
  )
  return match ? match[1] : null
}
