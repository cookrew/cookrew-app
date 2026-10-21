// THE PAGE'S CONNECTIONS, under HTTP/1.1. cookrew.dev answers HTTP/2, where
// one connection carries every stream; a page served over HTTP/1.1 (the
// strata preview, a LAN name, a dev server) gets SIX connections per origin
// from Chrome, and every open stream holds one for as long as it is open.
// Five levels streams plus an embed's three left a deep-linked terminal
// hidden and empty, and a detail fetch that never finished. So over HTTP/1.1
// the embed's documents take their connections first, one stays free for
// ordinary requests, and the fleet streams at most four machines in what is
// left (the machine the user is in first: fleet-store.ts streamSet).
import type { FrameView } from '../embed/embed-pool'

export const HTTP1_CONNECTIONS = 6
/** Kept free for ordinary requests: a detail, a snapshot, a POST from the terminal. */
export const HTTP1_SPARE = 1
export const HTTP1_MAX_STREAMS = 4
/** What one embed document holds open: events, the terminal stream and its live tail. */
export const EMBED_DOC_STREAMS = 3
/** A prewarmed document with no agent: its events stream. */
export const BARE_DOC_STREAMS = 1

/** The protocol this page was served over, as the browser negotiated it. */
export const pageProtocol = (): string => {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return nav?.nextHopProtocol ?? ''
  } catch {
    return ''
  }
}

export const isHttp1 = (protocol: string): boolean => /^http\/1(\.\d)?$/i.test(protocol)

/** What the embed holds: a document loading or showing an agent will hold all three. */
export const embedStreams = (frames: readonly FrameView[]): number =>
  frames.reduce((n, f) => n + (f.state === 'loading' || f.agentId !== null ? EMBED_DOC_STREAMS : BARE_DOC_STREAMS), 0)

/** How many levels streams the fleet may hold; Infinity when the protocol multiplexes. */
export const fleetStreamLimit = (protocol: string, frames: readonly FrameView[]): number =>
  isHttp1(protocol) ? Math.max(0, Math.min(HTTP1_MAX_STREAMS, HTTP1_CONNECTIONS - HTTP1_SPARE - embedStreams(frames))) : Number.POSITIVE_INFINITY
