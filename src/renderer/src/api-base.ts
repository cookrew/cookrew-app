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
 * The slug is read ONCE (machine-scope.ts, at module load), deliberately. It
 * is a property of the document the client was served in; re-reading it later
 * would let a mutation of the global silently re-point a live client at
 * another workspace.
 */

import { dataPlane, planePath, planeRequestInit, type PlaneRequestInit } from './data-plane'
import { machineScope, scopeBase, scopeNeedsMachine } from './machine-scope'

/**
 * WHERE THE MACHINE IN SCOPE ANSWERS, which is not always this page's origin.
 *
 * On a machine's own page it is '' : the machine served the page and answers
 * at its own root. On the console it is the machine's address on the relay,
 * `<api origin>/api/m/<machine id>`, a different origin from the page, and it
 * CHANGES when another machine is entered (machine-scope.ts). So it is read
 * at each request and never kept: a base remembered across a change of
 * machine is a page showing one machine and asking another.
 *
 * COMPOSED WITH THE SLUG, not preferred over it. The two answer different
 * questions: where the machine is, and which of its workspaces a page served
 * under `/<slug>` is for.
 */

/** The workspace slug this client was served for, or '' at the root and on the console. */
export const clientSlug = (): string => machineScope().slug

/** The relay address of the machine in scope, or '' on a machine's own page. */
export const clientBase = (): string => scopeBase()

/** No machine is in scope on a page that must name one (the console, at its Devices level). */
export class NoMachineInScope extends Error {
  constructor() {
    super('no machine is in scope')
    this.name = 'NoMachineInScope'
  }
}

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
  // ASKED OF NOBODY IS REFUSED, not sent somewhere: with no machine in scope
  // the base would be '', and a request built on it would go to the console's
  // own origin and be answered by its static host as if a machine had spoken.
  if (scopeNeedsMachine() && machineScope().machineId === null) throw new NoMachineInScope()
  return planePath(dataPlane(), clientBase(), clientSlug(), path)
}

/**
 * The fetch options this request needs, given where the plane is pointing.
 *
 * Carries the local-network annotation on a direct plane, which is why every
 * call site that already went through planeFetch is covered by Chrome 142
 * without being touched.
 */
export function apiRequestInit(): PlaneRequestInit {
  return planeRequestInit(dataPlane(), clientBase())
}
