/**
 * Where this client's API calls go.
 *
 * The renderer bundle is the phone client, and it issues root-absolute
 * `/api/...` requests. Served at `/` that is correct — the server binds those
 * to the focused session. Served at `/<slug>` it was NOT: the page would render
 * one workspace's URL while reading and writing whichever workspace the desktop
 * happened to be looking at. A wrong answer that looks right, which is why the
 * server refused to serve the client under a slug at all until this existed
 * (mobile-slug-route.ts, SCOPE_AWARE).
 *
 * mobile-server injects `window.COOKREW_SLUG` into the boot script of both
 * index paths — the built bundle and the vite dev proxy. Empty at the
 * unslugged root, so `apiPath` is the identity there and nothing about the
 * existing client changes.
 *
 * Read ONCE at module load, deliberately. The slug is a property of the
 * document the client was served in; re-reading it later would let a mutation
 * of the global silently re-point a live client at another workspace.
 */

const injected = (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
const SLUG = typeof injected === 'string' ? injected : ''

/** '' at the root, '/<slug>' under a workspace scope. */
export const API_BASE = SLUG ? `/${SLUG}` : ''

/** The workspace slug this client was served for, or '' at the root. */
export const clientSlug = (): string => SLUG

/**
 * Scope a root-absolute API path to the workspace this client was served for.
 *
 * EVERY request the client makes must go through this — including the SSE and
 * stream URLs, which are the dangerous ones: a mis-scoped fetch usually fails
 * visibly, but a mis-scoped EventSource connects happily and quietly feeds the
 * wrong canvas's state forever.
 */
export function apiPath(path: string): string {
  return `${API_BASE}${path}`
}
