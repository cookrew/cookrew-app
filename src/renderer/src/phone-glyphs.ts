/**
 * Claude Code's symbols, as a phone can draw them. Pure — the overlay applies
 * it to every chunk a remote viewer writes into its terminal (the history the
 * phone's sheet copies comes out of the same buffer).
 *
 * Three reports, each a symbol from Unicode's media-control block:
 *
 *   - THE MURDER WEAPON (black box, 2026-08-27): both kills of the iOS page
 *     ended at Claude Code's composer line, whose U+23F5 ⏵ is an
 *     EMOJI-PRESENTATION candidate on Apple platforms; iOS 26.6's text engine
 *     died resolving that fallback inside xterm's DOM-renderer grid. VS15
 *     (U+FE0E, zero width) pins every media-control symbol to TEXT
 *     presentation — same glyph, same cell width, no emoji path.
 *   - ⏺, Claude Code's mark on every line it says, becomes ● (one cell, as
 *     Claude Code prints it off the Mac): Samsung's browser draws it as an
 *     orange emoji button whatever selector follows it (owner, 2026-10-31).
 *   - ⏵⏵, the footer's mode arrows ("⏵⏵ bypass permissions on"), were two tofu
 *     boxes in Samsung Browser (2026-11-01): no font on the phone has U+23F5,
 *     and a fallback that does not exist has no width to agree on. ⏴ ⏵ become
 *     ‹ ›, which the bundled JetBrains Mono subset carries
 *     (fonts/jetbrains-mono.woff2; checked against its cmap), so every phone
 *     draws them in the terminal's own font, one cell each.
 */

/** Drawn in the bundled font instead: ⏴ → ‹, ⏵ → ›, ⏺ → ●. */
const SWAPS: Readonly<Record<string, string>> = {
  '\u23F4': '\u2039',
  '\u23F5': '\u203A',
  '\u23FA': '\u25CF'
}

/** The media-control symbols left as they are (⏩ to ⏹), pinned to text presentation. */
const MEDIA = /[\u23E9-\u23F9]/g

export function phoneGlyphs(raw: string): string {
  return raw.replace(/[\u23F4\u23F5\u23FA]/g, (m) => SWAPS[m] ?? m).replace(MEDIA, (m) => `${m}\uFE0E`)
}
