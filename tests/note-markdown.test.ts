import { describe, expect, it } from 'vitest'
import { escapeHtml, renderNoteMarkdown, safeUrl } from '../src/renderer/src/note-markdown'

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
