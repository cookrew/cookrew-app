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

import { dataPlane, planePath, planeRequestInit, type PlaneRequestInit } from './data-plane'

const injected = (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
const SLUG = typeof injected === 'string' ? injected : ''

/**
 * THE PREFIX THE WHOLE APP IS SERVED UNDER, which is not always `/`.
 *
 * Through the relay the companion lives at `/relay/@user/desktop/<id>/`. Every
 * root-absolute request the bundle makes would otherwise leave that prefix and
 * land on cookrew.dev's own routes — the page renders and then talks to the
 * registry instead of the Mac, which is what pressing OPEN on /me did.
 *
 * COMPOSED WITH THE SLUG, not preferred over it. The two answer different
 * questions — where this app is served from, and which workspace it is for —
 * and a relayed client under a slug needs both. Injected by mobile-server and
 * believed only when it came down the bridge (see relay-base.ts).
 */
const injectedBase = (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
const BASE = typeof injectedBase === 'string' ? injectedBase.replace(/\/+$/, '') : ''

/**
 * '' at the root, '/<slug>' under a workspace scope, prefixed by any base.
 *
 * THE RELAY PLANE'S PREFIX, and only that. It is still a constant because the
 * two things in it are constants — where this bundle was served from, and
 * which workspace it is for. Which TRANSPORT carries a request is a different
 * question and lives in data-plane.ts, where it can change without a reload.
 */
export const API_BASE = `${BASE}${SLUG ? `/${SLUG}` : ''}`

/** The workspace slug this client was served for, or '' at the root. */
export const clientSlug = (): string => SLUG

/** The relay prefix this client was served under, or '' when it is at the root. */
export const clientBase = (): string => BASE

/**
 * Scope a root-absolute API path to the workspace this client was served for,
 * ON WHICHEVER TRANSPORT IS CARRYING THE DATA PLANE RIGHT NOW.
 *
 * EVERY request the client makes must go through this — including the SSE and
 * stream URLs, which are the dangerous ones: a mis-scoped fetch usually fails
 * visibly, but a mis-scoped EventSource connects happily and quietly feeds the
 * wrong canvas's state forever.
 *
 * It is now READ PER REQUEST rather than composed once. That is the whole of
 * phase C3 at this seam: a live switch onto the LAN is a different answer from
 * this function and nothing else. Every call site that already went through
 * here follows for free — which is why the conformance sweep in
 * tests/api-base.test.ts that forbids a hand-built `/api/...` URL matters more
 * now than when it was only about the workspace slug.
 */
export function apiPath(path: string): string {
  return planePath(dataPlane(), BASE, SLUG, path)
}

/**
 * The fetch options this request needs, given where the plane is pointing.
 *
 * Carries the local-network annotation on a direct plane, which is why every
 * call site that already went through planeFetch is covered by Chrome 142
 * without being touched.
 */
export function apiRequestInit(): PlaneRequestInit {
  return planeRequestInit(dataPlane())
}
