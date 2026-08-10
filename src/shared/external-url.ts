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
  if (isWebUrl(url)) return canBridge ? 'bridge' : 'anchor'
  return canBridge ? 'disabled' : 'hidden'
}
