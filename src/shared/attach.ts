/**
 * File attachments: a dropped or picked file becomes an absolute path pasted
 * into the terminal (Terminal.app-style), so agents read the file themselves.
 * Shared by the desktop renderer, the mobile clients and the main process.
 */

/** Characters safe to leave unescaped in an interactively pasted path. */
const SHELL_SAFE = /[A-Za-z0-9_\-./+:@,%=]/

/**
 * Terminal.app-style backslash escaping: `/tmp/My File.png` →
 * `/tmp/My\ File.png`. Works unquoted in POSIX shells and is what agent
 * TUIs (Claude Code etc.) expect from a drag-in.
 */
export function shellQuotePath(filePath: string): string {
  return Array.from(filePath, (ch) => {
    if (SHELL_SAFE.test(ch)) return ch
    // Control characters (ESC, CR/LF, …) must never reach the terminal —
    // backslash-escaping would keep the raw byte and let a hostile filename
    // inject escape sequences into the paste stream.
    if (ch < ' ' || ch === '\x7f') return ''
    return `\\${ch}`
  }).join('')
}

/**
 * One bracketed-paste chunk carrying the escaped path(s) plus a trailing
 * space, matching how native terminals insert dropped files. Bracketed
 * paste keeps agent TUIs from treating the text as keystrokes (same
 * convention as the fork preamble injection).
 */
export function buildAttachmentPaste(paths: string[]): string {
  if (paths.length === 0) return ''
  return `\x1b[200~${paths.map(shellQuotePath).join(' ')} \x1b[201~`
}

const MAX_NAME_LENGTH = 80

/**
 * Reduce an uploaded filename to a safe basename: no separators (kills path
 * traversal), no shell-hostile characters, no leading dots, bounded length
 * with the extension preserved.
 */
export function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[-.]+|-+$/g, '')
  if (cleaned.length === 0) return 'file'
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 ? cleaned.slice(dot).slice(0, 16) : ''
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext
}
