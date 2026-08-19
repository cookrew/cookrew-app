import { Marked, type Tokens } from 'marked'

/**
 * Note bodies render markdown — and ONLY markdown.
 *
 * WHY THIS EXISTS
 * ---------------
 * A note card paints its body with dangerouslySetInnerHTML, and marked passes
 * raw HTML straight through. The CHECKPOINT UX PROGRAM SPEC note carries a
 * structure diagram Fresco wrote for Velvet, indented by two spaces:
 *
 *   <div class="cr-ckpt-scrub-preview" style="top:<thumbY>">
 *     <div class="cr-ckpt-row active">        (the FOCUSED checkpoint; keep .active)
 *       <span class="cr-ckpt-row-actions"><button class="cr-ckpt-action">… ROLE</button>…
 *
 * Two spaces is not a code block (four is), so every one of those tags became
 * REAL DOM inside the card — and every class name in it is a live app class.
 * `.cr-ckpt-scrub-preview` is `position:absolute; top:0; transform:translateY(-50%);
 * z-index:5`, so the diagram tore out of the card and floated over the note's own
 * header; `.cr-ckpt-fan-focus` is 336px, so the trailing comment wrapped to three
 * words a line; and `.cr-ckpt-row:hover .cr-ckpt-row-actions` lit up real-looking
 * ROLE / FORK buttons under the cursor. That is the whole screenshot.
 *
 * The same hole is a stored-XSS one. Notes are written by agents, by the CLI and
 * by the phone — `<img src=x onerror=…>` runs on render, and marked 15 emits a
 * `javascript:` href untouched.
 *
 * So: HTML inside a note is TEXT. That is what someone typing a structure diagram
 * meant, it is what the trace renderer already does (markdown.ts: "no raw HTML
 * pass-through"), and it is the only reading that cannot reach into the app.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

/** Render `input` as literal text inside markup. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

/** Schemes a note may link or embed. Everything else is dropped, not linked. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto'])
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * The URL to emit for `href`, or null when it names a scheme that executes.
 *
 * Scheme-less (relative, anchor, protocol-relative) URLs pass — they can only
 * ever be a navigation. The check runs on a copy with C0 whitespace stripped
 * because a browser strips it too, so `java\nscript:x` is `javascript:x` to
 * everything downstream and must be to us as well.
 */
export function safeUrl(href: string): string | null {
  const trimmed = href.trim()
  const scheme = SCHEME.exec(trimmed.replace(/[\u0000-\u0020]/g, ''))
  if (scheme === null) return trimmed
  return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? trimmed : null
}

const noteMarked = new Marked({
  renderer: {
    /** Covers BOTH block and inline HTML tokens — the whole pass-through. */
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.raw)
    },
    link(token: Tokens.Link): string {
      const url = safeUrl(token.href)
      const label = this.parser.parseInline(token.tokens)
      // A refused scheme still shows its label: dropping the anchor must not
      // silently delete a sentence out of someone's note.
      if (url === null) return label
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<a href="${escapeHtml(url)}"${title}>${label}</a>`
    },
    image(token: Tokens.Image): string {
      const url = safeUrl(token.href)
      const alt = escapeHtml(token.text)
      if (url === null) return alt
      return `<img src="${escapeHtml(url)}" alt="${alt}">`
    }
  }
})

/** Note content → HTML for the card body. Inert: no tag survives from the source. */
export function renderNoteMarkdown(content: string): string {
  return noteMarked.parse(content, { async: false })
}
