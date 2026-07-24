// Detect a canvas browser pointed at Cookrew itself. The flag-off renderer uses
// this to prevent a legacy webview/iframe from recursively embedding the whole
// canvas, opening another set of browser nodes and PTY/SSE streams per layer.
// The flag-on contract keeps the node-owned headless stream instead.

/** Ports that are always Cookrew's own mobile companion server. */
const COOKREW_MOBILE_PORTS = new Set(['8639', '8643'])

/**
 * True when a canvas-browser URL would load Cookrew inside Cookrew: the
 * app's own origin (covers the dev server in dev builds) or the mobile
 * companion ports on any host. Unparseable URLs are not blocked here; the
 * selected renderer handles them normally.
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
