// A GitHub table in a reply renders as a real table in CHAT (UI/UX QA, Gauge,
// 2026-11-01), in its own sideways-scrolling box so a wide one never widens a
// phone's page; anything not a table stays text.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../src/renderer/src/MarkdownText'

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
