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
// So the shape changes for the clients that cannot carry it. A tailnet peer
// gets the built bundle: three requests instead of 159, one level deep. The
// LAN keeps the live graph, because the LAN can afford it and that is where
// the edit-reload loop actually happens.
//
// The cost is honesty: a build can be old. buildAge() exists so the phone can
// be TOLD, rather than quietly shown last week's UI.
//
// SCOPE — a decision function. It opens nothing and reads nothing.

import { isTailnetAddress } from './tailscale'

export type RendererSource = 'dev' | 'built'

export interface RendererChoice {
  /** Peer address from the socket; may be IPv4-mapped. */
  remoteAddress: string | undefined
  /** True when electron-vite's dev server is reachable. */
  devAvailable: boolean
  /** True when out/renderer holds an index.html. */
  builtAvailable: boolean
}

/** `::ffff:100.68.81.64` → `100.68.81.64`; dual-stack peers arrive mapped. */
function unmap(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1] : address
}

/**
 * Where this client's renderer should come from.
 *
 * Only ONE case diverts to the build: a tailnet peer while both are available.
 * Everything else keeps today's behaviour exactly — with no build there is
 * nothing to divert to, and with no dev server the build is all there is.
 */
export function rendererSourceFor(choice: RendererChoice): RendererSource {
  if (!choice.devAvailable) return 'built'
  if (!choice.builtAvailable) return 'dev'
  const peer = choice.remoteAddress ? unmap(choice.remoteAddress) : ''
  return isTailnetAddress(peer) ? 'built' : 'dev'
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
