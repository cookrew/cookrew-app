// Which renderer a given client gets: Vite's live module graph, or the build.
//
// WHY THIS EXISTS
// ---------------
// In development the companion proxies Vite, so a phone sees the code being
// edited. That is the right default and it is what makes the phone useful
// while working. But it ships the module graph UNBUNDLED. Measured on this
// app: 159 separate requests, 4.57 MB, six levels of import waterfall.
//
// On the LAN that costs 0.3 s and nobody notices. Over a tailnet with no
// direct path — DERP relay, 293 ms to 2.5 s round trip, two of five probes
// lost — 159 dependent requests over six HTTP/1.1 connections do not finish.
// The phone shows white. The desktop is fine, the cert is fine, the server
// answers instantly; the link simply cannot carry that shape of payload.
//
// So the shape changes for the clients that cannot carry it. A remote peer
// gets the built bundle: three requests instead of 159, one level deep.
//
// LAN LEARNED THE SAME LESSON THE HARD WAY. The live graph is also React in
// DEV MODE — StrictMode double-renders, unminified deps — and its module
// graph goes stale on every dev-server restart. A real iPhone on the LAN,
// holding the tab across a day of edits and restarts, reloads into broken
// half-graphs and dev-mode weight until Safari reports "this page has
// repeatedly encountered a problem". So the default flipped: EVERY non-
// loopback client gets the build. Loopback keeps the live graph — that is
// the desktop QA emulators and the edit-reload loop — and any client can
// still ask for it explicitly with ?renderer=dev.
//
// The cost is honesty: a build can be old. buildAge() exists so the phone can
// be TOLD, rather than quietly shown last week's UI.
//
// SCOPE — a decision function. It opens nothing and reads nothing.

export type RendererSource = 'dev' | 'built'

export interface RendererChoice {
  /** Peer address from the socket; may be IPv4-mapped. */
  remoteAddress: string | undefined
  /** True when electron-vite's dev server is reachable. */
  devAvailable: boolean
  /** True when out/renderer holds an index.html. */
  builtAvailable: boolean
  /** Explicit `?renderer=` override from the client, when present. */
  requested?: RendererSource | null
}

/** `::ffff:100.68.81.64` → `100.68.81.64`; dual-stack peers arrive mapped. */
function unmap(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1] : address
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}

/**
 * Where this client's renderer should come from. With only one source there
 * is no choice; with both, an explicit request wins, then loopback keeps the
 * live graph and everyone else gets the build.
 */
export function rendererSourceFor(choice: RendererChoice): RendererSource {
  if (!choice.devAvailable) return 'built'
  if (!choice.builtAvailable) return 'dev'
  if (choice.requested === 'dev' || choice.requested === 'built') return choice.requested
  const peer = choice.remoteAddress ? unmap(choice.remoteAddress) : ''
  return isLoopback(peer) ? 'dev' : 'built'
}

/**
 * A one-line notice for a build old enough to mislead, or null when it is
 * fresh. Injected into the served HTML: a phone shown a week-old UI must be
 * able to see that from the phone, not by asking the desktop.
 */
export function staleBuildNotice(builtAt: Date | null, newestSourceAt: Date | null): string | null {
  if (!builtAt || !newestSourceAt) return null
  if (builtAt.getTime() >= newestSourceAt.getTime()) return null
  const days = Math.floor((newestSourceAt.getTime() - builtAt.getTime()) / 86_400_000)
  const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'} behind` : 'behind'
  return `Built bundle is ${age} the source — run npm run build to refresh this view.`
}
