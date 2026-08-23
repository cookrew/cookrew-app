import { beforeEach, describe, expect, it } from 'vitest'
import { escapeHtml, renderNoteMarkdown, safeUrl, clearNoteMarkdownCache } from '../src/renderer/src/note-markdown'

/**
 * The bug, verbatim. These six lines are copied out of the live CHECKPOINT UX
 * PROGRAM SPEC note — Fresco's structure diagram for Velvet, indented by two
 * spaces. marked passed them through as HTML, the card painted them with
 * dangerouslySetInnerHTML, and because every class in them is a real app class
 * the diagram styled itself: `.cr-ckpt-scrub-preview` is absolute + z-index 5
 * with translateY(-50%), so it climbed out of the card and sat across the
 * note's own header, and `.cr-ckpt-row:hover .cr-ckpt-row-actions` put live
 * ROLE / FORK buttons under the cursor.
 */
const SPEC_DIAGRAM = [
  '>>> VELVET — REQUIRED COMPONENT CHANGE (contract): the tab must now render a real row INSIDE the wrapper:',
  '  <div class="cr-ckpt-scrub-preview" style="top:<thumbY>">',
  '    <div class="cr-ckpt-row active">                              (the FOCUSED checkpoint; keep .active)',
  '      <span class="cr-ckpt-row-actions"><button class="cr-ckpt-action">ROLE</button></span>',
  '      <span class="cr-ckpt-dot"><i></i></span>',
  '    </div>',
  '  </div>'
].join('\n')

describe('the note that floated over its own header', () => {
  const html = renderNoteMarkdown(SPEC_DIAGRAM)

  it('emits no element from the note source', () => {
    expect(html).not.toContain('<div')
    expect(html).not.toContain('<span')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<i>')
  })

  it('carries no app class that could style it', () => {
    // The escaped text still SAYS cr-ckpt-scrub-preview — it just can't be one.
    expect(html).not.toMatch(/class="cr-ckpt/)
    expect(html).toContain('cr-ckpt-scrub-preview')
  })

  it('still reads as the diagram the author typed', () => {
    expect(html).toContain('&lt;div class=&quot;cr-ckpt-row active&quot;&gt;')
    expect(html).toContain('(the FOCUSED checkpoint; keep .active)')
  })
})

describe('renderNoteMarkdown', () => {
  it('renders the markdown a note actually uses', () => {
    const html = renderNoteMarkdown('# Spec\n\n**bold** and `code`\n\n- one\n- two')
    expect(html).toContain('<h1>Spec</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
  })

  it('escapes inline HTML too, not just blocks', () => {
    expect(renderNoteMarkdown('a <b>word</b> mid-sentence')).toContain('&lt;b&gt;word&lt;/b&gt;')
  })

  it('defuses the executable ones', () => {
    // Notes are written by agents, the CLI and the phone; an onerror in one of
    // them used to run on every render of that card.
    const html = renderNoteMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('keeps a real link, drops an executable one but keeps its words', () => {
    expect(renderNoteMarkdown('[docs](https://example.com/x)')).toContain(
      '<a href="https://example.com/x">docs</a>'
    )
    const bad = renderNoteMarkdown('[press me](javascript:alert(1))')
    expect(bad).not.toContain('<a ')
    expect(bad).toContain('press me')
  })

  it('drops an executable image source, keeping the alt text', () => {
    const html = renderNoteMarkdown('![diagram](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).toContain('diagram')
  })

  it('leaves a fenced code block fenced', () => {
    const html = renderNoteMarkdown('```html\n<div class="cr-ckpt-row">x</div>\n```')
    expect(html).toContain('<pre><code')
    expect(html).toContain('&lt;div class=&quot;cr-ckpt-row&quot;&gt;')
  })

  it('renders an empty note without throwing', () => {
    expect(renderNoteMarkdown('')).toBe('')
  })
})

describe('safeUrl', () => {
  it('passes the schemes a note legitimately links', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com')
    expect(safeUrl('http://example.com')).toBe('http://example.com')
    expect(safeUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('passes scheme-less URLs — they can only navigate', () => {
    expect(safeUrl('#anchor')).toBe('#anchor')
    expect(safeUrl('/local/path')).toBe('/local/path')
    expect(safeUrl('../sibling.md')).toBe('../sibling.md')
  })

  it('refuses the executable schemes, however they are spelled', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('  JavaScript:alert(1)')).toBeNull()
    // A browser strips C0 whitespace out of a URL before resolving the scheme,
    // so a split one is still javascript: by the time it matters.
    expect(safeUrl('java\nscript:alert(1)')).toBeNull()
    expect(safeUrl('java\tscript:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeUrl('vbscript:msgbox(1)')).toBeNull()
  })
})

describe('escapeHtml', () => {
  it('escapes every character that can open a tag or break an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    )
  })

  it('leaves ordinary prose alone', () => {
    expect(escapeHtml('a plain sentence — with an em dash')).toBe(
      'a plain sentence — with an em dash'
    )
  })
})

/**
 * The render cache. NoteNode calls renderNoteMarkdown from its render body, so
 * every canvas re-render re-parsed every note: measured at 89ms of marked.js
 * inside a 215ms card open, for output the zoom LOD change then discarded.
 */
describe('renderNoteMarkdown caches, and stays bounded', () => {
  beforeEach(() => clearNoteMarkdownCache())

  it('returns the same HTML for the same source', () => {
    const src = '# heading\n\nsome **bold** text'
    expect(renderNoteMarkdown(src)).toBe(renderNoteMarkdown(src))
  })

  it('does not re-parse a source it has already seen', () => {
    // Identity, not equality: a cache hit returns the STORED string, so the two
    // calls share one object. A re-parse would produce an equal-but-new one.
    const src = '- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |'
    const first = renderNoteMarkdown(src)
    const second = renderNoteMarkdown(src)
    expect(Object.is(first, second)).toBe(true)
  })

  it('still re-parses when the note is edited', () => {
    expect(renderNoteMarkdown('one')).not.toBe(renderNoteMarkdown('two'))
  })

  it('keeps escaping and link safety on the cached path', () => {
    // The cache must not become a way to serve unsanitised HTML on the second
    // read — the sanitisation lives in the parse, so this asserts the stored
    // value is the sanitised one and not the source.
    const hostile = '<img src=x onerror=alert(1)>'
    const once = renderNoteMarkdown(hostile)
    const twice = renderNoteMarkdown(hostile)
    expect(twice).toBe(once)
    // No live TAG survives. The escaped text still contains the literal
    // characters "onerror=alert(1)" — asserting on that substring failed the
    // first version of this test against correctly-sanitised output.
    expect(twice).not.toContain('<img')
    expect(twice).toContain('&lt;img')
  })

  it('evicts rather than growing without limit', () => {
    // A note body is unbounded; the cache must not be. 64 entries, so 200
    // distinct sources must not leave 200 behind.
    for (let i = 0; i < 200; i++) renderNoteMarkdown(`note number ${i}`)
    // the oldest is gone: re-rendering it produces a fresh object
    const oldAgain = renderNoteMarkdown('note number 0')
    expect(Object.is(oldAgain, renderNoteMarkdown('note number 0'))).toBe(true)
    // and the most recent is still a hit
    expect(Object.is(renderNoteMarkdown('note number 199'), renderNoteMarkdown('note number 199'))).toBe(true)
  })
})
