/**
 * URLs that may be handed to a REAL browser ("open in browser" button, phone
 * deep-link handoff). Web URLs only: shell.openExternal on any other scheme
 * (file:, smb:, app-custom) launches whatever local handler claims it.
 *
 * The canonical form is what gets OPENED, not the raw string: WHATWG URL
 * strips embedded tab/newline and trims junk, so a raw string that VALIDATES
 * as https can still read differently to the OS-level parser it is handed to
 * ('ht\ntps://…'). Validating and opening the same parsed .href closes that
 * gap — the renderer uses these to decide what to show, the main-process
 * shell:openExternal handler re-derives the canonical form as the boundary.
 */
export function canonicalWebUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const web = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return web ? parsed.href : null
  } catch {
    return null
  }
}

export function isWebUrl(url: string): boolean {
  return canonicalWebUrl(url) !== null
}

/**
 * File types a browser RENDERS. The allowlist is the whole safety argument for
 * letting file: through: shell.openExternal hands the path to the OS default
 * handler for that extension, so `.command`, `.sh`, `.app`, `.pkg` and friends
 * would be EXECUTED, not displayed. A page can steer its own tab's url
 * (did-navigate, window.open), so this boundary cannot assume a human typed it.
 *
 * Deny-listing executables would be the wrong shape — every OS keeps inventing
 * new ones, and the miss is arbitrary code execution.
 */
const RENDERABLE_FILE_TYPES = new Set([
  'html', 'htm', 'xhtml',
  'pdf',
  'txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'
])

/** Lowercased extension of a URL's PATH — query and fragment cannot spoof it. */
function pathExtension(parsed: URL): string | null {
  const path = parsed.pathname
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot < 0 || dot < slash || dot === path.length - 1) return null
  return decodeURIComponent(path.slice(dot + 1)).toLowerCase()
}

/**
 * What may be handed to a real browser — web URLs, plus a LOCAL FILE the
 * browser can render.
 *
 * The file case exists because local .html reports are a normal product of
 * working here: they get opened in a canvas browser, and "open this properly"
 * has to reach a real browser. Refusing all of file: left that button
 * permanently disabled on precisely the cards that needed it.
 *
 * Returns the canonical href, so what was validated is what gets opened.
 */
export function canonicalExternalUrl(url: string): string | null {
  const web = canonicalWebUrl(url)
  if (web !== null) return web
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    const ext = pathExtension(parsed)
    return ext !== null && RENDERABLE_FILE_TYPES.has(ext) ? parsed.href : null
  } catch {
    return null
  }
}

export type ExternalOpenMode = 'hidden' | 'disabled' | 'bridge' | 'anchor'

/**
 * Which control the "open in browser" affordance renders as. Bridge present
 * (Electron desktop) → a button through shell.openExternal, DISABLED rather
 * than absent for non-web URLs (about:blank on a fresh tab) so the header
 * does not reflow on first navigation. No bridge (phone companion / demo
 * tab) → a genuine anchor — a real user-gesture https navigation is what iOS
 * Universal Links / Android App Links require — and there is no disabled
 * anchor, so a non-web URL hides it.
 */
export function externalOpenMode(canBridge: boolean, url: string): ExternalOpenMode {
  // The desktop can also open a local document (see canonicalExternalUrl); the
  // phone cannot — a file: path names a file on a machine it is not sitting at,
  // so the anchor stays web-only rather than offering a link that goes nowhere.
  if (canBridge) return canonicalExternalUrl(url) !== null ? 'bridge' : 'disabled'
  return isWebUrl(url) ? 'anchor' : 'hidden'
}
