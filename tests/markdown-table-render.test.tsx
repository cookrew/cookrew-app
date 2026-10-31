// A GitHub table in a reply renders as a real table in CHAT (UI/UX QA, Gauge,
// 2026-11-01), in its own sideways-scrolling box so a wide one never widens a
// phone's page; anything not a table stays text.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText, tableEdge } from '../src/renderer/src/MarkdownText'

const html = (source: string): string => renderToStaticMarkup(<MarkdownText source={source} />)
const reply = ['Done.', '', '| Entry point | Before | Now |', '|:---|---|---:|', '| `cookrew ask` | **already** resumed it | wakes it |'].join('\n')

describe('a markdown table in CHAT', () => {
  it('is a table: header cells, body cells, inline code and bold inside them', () => {
    const out = html(reply)
    expect(out).toContain('<div class="md-table" role="region" aria-label="Table" tabindex="0"><table><thead><tr>')
    expect(out).toContain('<th style="text-align:left">Entry point</th><th>Before</th><th style="text-align:right">Now</th>')
    expect(out).toContain('<td style="text-align:left"><code>cookrew ask</code></td><td><strong>already</strong> resumed it</td>')
    expect(out).not.toContain('|---')
  })

  it('a header with no separator is still the plain text it was', () => {
    expect(html('| a | b |\n| 1 | 2 |')).toBe('<p>| a | b | | 1 | 2 |</p>')
  })

  it('scrolls sideways in its own box, on paper, so the chat never widens', () => {
    const css = readFileSync(new URL('../src/renderer/src/transcript-paper.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.ctx-block-reply \.md-table \{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/)
    expect(css).toMatch(/\.ctx-block-reply \.md-table th \{[^}]*background:\s*var\(--cream-md\)/)
  })
})

// Gauge's finishing touches (r3): on a 1440 desktop Conductor's table was laid
// out at its widest (748px in a 718px box) and cut mid-word in the last
// column; on a phone nothing showed the table went on to the right.
describe('a table fits its box when it can, and shows when it does not', () => {
  const css = readFileSync(new URL('../src/renderer/src/transcript-paper.css', import.meta.url), 'utf8')

  it('lays out to the box, wrapping its columns; it overflows only past their narrowest', () => {
    const table = css.match(/\.ctx-block-reply \.md-table table \{([^}]*)\}/)?.[1] ?? ''
    expect(table).toMatch(/width:\s*100%/)
    expect(table).not.toMatch(/max-content/)
  })

  it('sits in a box that can show which side has more', () => {
    expect(html(reply)).toContain('<div class="md-table-box"><div class="md-table" role="region"')
  })

  it('fades the cut edge while there is more off that side, and only then', () => {
    expect(css).toMatch(/\.md-table-box\[data-more='right'\]::after,\s*\.lod-overlay \.ctx-block-reply \.md-table-box\[data-more='both'\]::after\s*\{[^}]*opacity:\s*1/)
    expect(css).toMatch(/\.md-table-box\[data-more='left'\]::before,\s*\.lod-overlay \.ctx-block-reply \.md-table-box\[data-more='both'\]::before\s*\{[^}]*opacity:\s*1/)
    expect(css).toMatch(/\.md-table-box::before,\s*\.lod-overlay \.ctx-block-reply \.md-table-box::after\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/)
  })
})

describe('which side of a scrolled table has more (tableEdge)', () => {
  it('none when it fits, right at the start, both mid-way, left at the end', () => {
    expect(tableEdge({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toBe(null)
    expect(tableEdge({ scrollLeft: 0, clientWidth: 274, scrollWidth: 622 })).toBe('right')
    expect(tableEdge({ scrollLeft: 100, clientWidth: 274, scrollWidth: 622 })).toBe('both')
    expect(tableEdge({ scrollLeft: 348, clientWidth: 274, scrollWidth: 622 })).toBe('left')
  })
})
