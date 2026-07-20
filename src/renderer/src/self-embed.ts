// Guard against pointing a canvas browser at Cookrew itself. A webview
// loading the app recursively embeds the whole canvas (which loads its own
// browser nodes, which embed it again…) — every layer renders, animates and
// opens PTY/SSE streams, pegging the GPU process. Seen in the wild via QA
// tabs on the mobile server; cost was ~90% GPU for hours.

/** Ports that are always Cookrew's own mobile companion server. */
const COOKREW_MOBILE_PORTS = new Set(['8639', '8643'])

/**
 * True when a canvas-browser URL would load Cookrew inside Cookrew: the
 * app's own origin (covers the dev server in dev builds) or the mobile
 * companion ports on any host. Unparseable URLs are not blocked here —
 * the webview will fail them on its own.
 */
export function isSelfEmbedding(url: string, appOrigin: string): boolean {
  try {
    const parsed = new URL(url)
    if (appOrigin.startsWith('http') && parsed.origin === appOrigin) return true
    return COOKREW_MOBILE_PORTS.has(parsed.port)
  } catch {
    return false
  }
}
