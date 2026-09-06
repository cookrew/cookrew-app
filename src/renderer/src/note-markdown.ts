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

/**
 * Rendered notes, keyed by a hash of their source.
 *
 * WHY A CACHE AND NOT useMemo. NoteNode called this straight from its render
 * body, so every canvas re-render re-parsed every note. Measured on the real
 * canvas — 27 notes, 430,409 chars, the largest 120,833 — opening one agent
 * card cost 215ms pointerdown-to-painted, of which 89ms (58%) was marked.js
 * under `NoteNode → renderWithHooks → performSyncWorkOnRoot`: a SYNCHRONOUS
 * render on the click path. The parsed output was then thrown away, because the
 * zoom LOD change unmounts the notes — note-body DOM writes during the open
 * measured ZERO. Work done, discarded, and invisible to anything watching the
 * DOM, which is why it survived this long.
 *
 * useMemo alone would not cover it: the notes UNMOUNT on zoom and remount on
 * the way back, and per-instance memo dies with the instance. A module cache
 * survives that, which is the access pattern here — content changes rarely,
 * mount/unmount churns constantly.
 *
 * BOUNDED IN BYTES, NOT ENTRIES. The first version held 64 entries, and a note
 * body is unbounded, so the cache's weight scaled with note size: measured
 * 2026-09-06, 64 cached 64 KB notes retained 51.5 MB — in the renderer, the
 * process iOS kills at 1.5 GB. Two things made an entry heavy, neither of them
 * the count. The key was the source itself, 64 KB retained per entry and a
 * DEAD copy once the note was edited. And the value was six times heavier
 * than its characters: marked builds its output by concatenation, V8 keeps
 * that as a rope of cons-string nodes, and the rope survived in the cache —
 * 771 KB for 132K chars of HTML, 129 KB once flattened. So:
 *
 *   - the key is `length:hash64`, about 25 chars, never the source. The trade
 *     is named: a hit costs the hash, 27 µs per 64 KB, where Map.get(source)
 *     was 0.01 µs because V8 memoises a string's hash — and it saves a third
 *     of every entry, and the dead copies of every edited note;
 *   - the HTML is flattened before it is stored (one indexed read makes V8
 *     collapse the rope in place; the string's identity does not change);
 *   - the bound is a running byte total against NOTE_CACHE_MAX_BYTES, with
 *     an estimate of 2 bytes per UTF-16 unit — an upper bound, since V8 keeps
 *     Latin-1 text at one byte per char — plus a fixed overhead per entry;
 *   - eviction is insertion order, oldest first, until the new entry fits.
 *     Not an LRU — the working set is the notes on one canvas, and a real LRU
 *     would cost a Map delete/set on every read to buy nothing measurable;
 *   - an entry that would not fit even in an empty cache never enters the
 *     map and evicts NOTHING: one giant note must not empty the cache for
 *     the other hundred cards. It is held in a single side slot instead, so
 *     it is not re-parsed on every React render either — the click-path
 *     stall is the reason the cache exists. Ill-formed UTF-16 (an unpaired
 *     surrogate, which any body truncated at a byte limit can carry) cannot
 *     be hashed safely and gets a side slot of its own, matched by exact
 *     source equality. Each slot is dropped above SIDE_SLOT_MAX_FACTOR times
 *     the budget, so "bounded" stays true of the whole module: at most the
 *     budget plus two slots of four budgets each, never "plus the largest
 *     note ever rendered";
 *
 * Why 8 MiB: the heaviest measured canvas renders to about 1.8 MB accounted,
 * so it fits whole with 4x room and no note re-parses on a zoom round trip;
 * and 8 MiB is under 1% of the renderer's ceiling, where the old bound had
 * none at all for notes larger than 64 KB.
 */
const NOTE_CACHE_MAX_BYTES = 8 * 1024 * 1024
/** A Map slot, two string headers, and the key's own characters. */
const ENTRY_OVERHEAD_BYTES = 128
const BYTES_PER_CHAR = 2
/** A side slot holds at most this many budgets; above it the render is not kept at all. */
const SIDE_SLOT_MAX_FACTOR = 4

interface CacheEntry {
  readonly html: string
  readonly bytes: number
}

interface SideSlot extends CacheEntry {
  /** The hash key (oversized) or the source itself (ill-formed, which cannot be hashed). */
  readonly match: string
}

let maxCacheBytes = NOTE_CACHE_MAX_BYTES
let cachedBytes = 0
let hits = 0
let misses = 0
let oversizedParses = 0
let illFormedParses = 0
const renderCache = new Map<string, CacheEntry>()
/** The one entry too large for the budget: outside the map and its total, matched by key. */
let oversizedSlot: SideSlot | null = null
/** The one ill-formed body: outside the map, matched by exact source equality. */
let illFormedSlot: SideSlot | null = null

/**
 * Hashing feeds a fixed scratch buffer and hashes it four bytes at a time.
 * encodeInto never splits a code point and the buffer size is a constant, so
 * the chunk boundaries — and therefore the key — are a pure function of the
 * content. Measured: 27 µs per 64 KB against 170 µs for a charCodeAt loop,
 * which matters because NoteNode calls this on every render, hits included.
 * The words are read native-endian: keys are in-process only and must never
 * be persisted or compared across machines.
 */
const HASH_CHUNK_BYTES = 64 * 1024
const hashScratch = new Uint8Array(HASH_CHUNK_BYTES)
const hashWords = new Uint32Array(hashScratch.buffer)
const utf8 = new TextEncoder()

/**
 * `length:h1:h2` — two 32-bit lanes of a cyrb53-style imul mix over the UTF-8
 * bytes, finished with an avalanche. The hash is not cryptographic and not
 * seeded, so a colliding pair is constructible by someone who can write
 * notes, and — the reason it is not seeded — a reported wrong-content render
 * reproduces. An accidental collision among N entries is about N² / 2⁶⁵ (and
 * the lengths must match too). Either shows one note's SANITISED render on
 * another note until either is edited — a display defect, never an unsafe
 * one, because every value in this cache came out of the sanitising renderer
 * above.
 *
 * Well-formed input only: encodeInto writes every lone surrogate as U+FFFD,
 * so two ill-formed bodies differing only in which lone surrogate they carry
 * would share a key. renderNoteMarkdown keeps those out of the map.
 */
export function noteMarkdownCacheKey(content: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  let offset = 0
  while (offset < content.length) {
    const { read, written } = utf8.encodeInto(offset === 0 ? content : content.substring(offset), hashScratch)
    if (read === 0) break
    offset += read
    const words = written >>> 2
    for (let i = 0; i < words; i += 1) {
      const w = hashWords[i]
      h1 = Math.imul(h1 ^ w, 2654435761)
      h2 = Math.imul(h2 ^ w, 1597334677)
    }
    for (let i = words << 2; i < written; i += 1) {
      const b = hashScratch[i]
      h1 = Math.imul(h1 ^ b, 2654435761)
      h2 = Math.imul(h2 ^ b, 1597334677)
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${content.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`
}

/** Accounted weight of one entry — the estimate the bound is kept in. */
export function noteMarkdownEntryBytes(key: string, html: string): number {
  return ENTRY_OVERHEAD_BYTES + BYTES_PER_CHAR * (key.length + html.length)
}

/**
 * marked's output is a rope, and V8 collapses it in place on the first
 * indexed read: same string, one sixth the retained bytes. The code unit is
 * folded into module state so the read is observable and cannot be dropped
 * as a pure expression with an unused result.
 */
let flattenSink = 0
function flattened(html: string): string {
  flattenSink ^= html.charCodeAt(0) | 0
  return html
}

/** One sanitised, flattened render. */
function parseNote(content: string): string {
  return flattened(noteMarked.parse(content, { async: false }))
}

function evictUntilFits(incoming: number): void {
  for (const [key, entry] of renderCache) {
    if (cachedBytes + incoming <= maxCacheBytes) return
    renderCache.delete(key)
    cachedBytes -= entry.bytes
  }
  if (cachedBytes + incoming > maxCacheBytes) {
    throw new Error(`note cache: ${incoming} bytes do not fit an empty ${maxCacheBytes}-byte budget`)
  }
}

/** The slot's new content, or null when the render is too large to keep even alone. */
function sideSlot(match: string, html: string, bytes: number): SideSlot | null {
  return bytes > SIDE_SLOT_MAX_FACTOR * maxCacheBytes ? null : { match, html, bytes }
}

/** Ill-formed UTF-16 cannot be hashed safely: rendered into its own slot, matched by the source itself. */
function renderIllFormed(content: string): string {
  if (illFormedSlot !== null && illFormedSlot.match === content) {
    hits += 1
    return illFormedSlot.html
  }
  illFormedParses += 1
  const html = parseNote(content)
  // The source is retained by the slot, so it is accounted alongside the html.
  illFormedSlot = sideSlot(content, html, noteMarkdownEntryBytes(content, html))
  return html
}

/** Note content → HTML for the card body. Inert: no tag survives from the source. */
export function renderNoteMarkdown(content: string): string {
  if (!content.isWellFormed()) return renderIllFormed(content)
  const key = noteMarkdownCacheKey(content)
  const hit = renderCache.get(key)
  if (hit !== undefined) {
    hits += 1
    return hit.html
  }
  if (oversizedSlot !== null && oversizedSlot.match === key) {
    hits += 1
    return oversizedSlot.html
  }
  const html = parseNote(content)
  const bytes = noteMarkdownEntryBytes(key, html)
  if (bytes > maxCacheBytes) {
    // Too big for the budget: the side slot, never the map. Evicts nothing.
    oversizedParses += 1
    oversizedSlot = sideSlot(key, html, bytes)
    return html
  }
  misses += 1
  evictUntilFits(bytes)
  renderCache.set(key, { html, bytes })
  cachedBytes += bytes
  return html
}

export interface NoteMarkdownCacheStats {
  readonly entries: number
  /** Accounted bytes in the map. Never above maxBytes. */
  readonly bytes: number
  readonly maxBytes: number
  /** Answered from the map or a side slot. */
  readonly hits: number
  /** Parsed and stored in the map. */
  readonly misses: number
  /** Parsed into the oversized slot: the entry outweighs the budget. */
  readonly oversizedParses: number
  /** Parsed into the ill-formed slot: the source has an unpaired surrogate. */
  readonly illFormedParses: number
  /** Accounted weight of the oversized slot; 0 when empty. Never above 4 × maxBytes. */
  readonly oversizedBytes: number
  /** Accounted weight of the ill-formed slot (source and html); 0 when empty. Never above 4 × maxBytes. */
  readonly illFormedBytes: number
}

/**
 * Read-only view of the accounting, for the tests and the perf eval. The
 * counters are the only honest way to see a hit: a string is a primitive, so
 * `Object.is(a, b)` is equality, not identity, and cannot tell a cached
 * answer from a fresh equal render.
 */
export function noteMarkdownCacheStats(): NoteMarkdownCacheStats {
  return {
    entries: renderCache.size,
    bytes: cachedBytes,
    maxBytes: maxCacheBytes,
    hits,
    misses,
    oversizedParses,
    illFormedParses,
    oversizedBytes: oversizedSlot === null ? 0 : oversizedSlot.bytes,
    illFormedBytes: illFormedSlot === null ? 0 : illFormedSlot.bytes
  }
}

/**
 * Test seam: the cache is module state, so a suite must be able to clear it.
 * `maxBytes` lets a unit test drive eviction with small notes; omitted, the
 * budget returns to the default, so one suite cannot leave it shrunk for the
 * next.
 */
export function clearNoteMarkdownCache(maxBytes: number = NOTE_CACHE_MAX_BYTES): void {
  renderCache.clear()
  oversizedSlot = null
  illFormedSlot = null
  cachedBytes = 0
  hits = 0
  misses = 0
  oversizedParses = 0
  illFormedParses = 0
  maxCacheBytes = maxBytes
}
