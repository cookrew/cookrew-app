// A PAGE AS DATA (shared/dom-mirror.ts): the rules a mirror must keep before it
// reaches a device that will draw it as its own content.
import { describe, expect, it } from 'vitest'
import { MIRROR_BLOCKS_MAX, MIRROR_TEXT_MAX, mirrorBlocks, mirrorText, pixelOnlyPage, safeHref } from '../src/shared/dom-mirror'

describe('text', () => {
  it('is one line, whitespace collapsed', () => {
    expect(mirrorText('  Hello\n\n\tthere  ')).toBe('Hello there')
  })

  it('is cut with an ellipsis rather than sent whole', () => {
    const long = 'x'.repeat(MIRROR_TEXT_MAX + 50)
    const cut = mirrorText(long)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBe(MIRROR_TEXT_MAX + 1)
  })
})

describe('a link address', () => {
  it('is kept as data when it is one', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('/relative/path')).toBe('/relative/path')
  })

  it('is dropped when it could run code', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox', '#same-page', '', null]) {
      expect(safeHref(bad as string | null)).toBeUndefined()
    }
  })
})

describe('blocks', () => {
  it('drop what says nothing, but keep a control that can be pressed', () => {
    const { blocks } = mirrorBlocks([
      { ref: 1, role: 'paragraph', text: '   ' },
      { ref: 2, role: 'button', text: '' },
      { ref: 3, role: 'separator', text: '' },
      { ref: 4, role: 'field', text: '', value: 'name' },
      { ref: 5, role: 'link', text: 'Go', href: 'javascript:alert(1)' }
    ])
    expect(blocks.map((b) => b.ref)).toEqual([2, 3, 4, 5])
    expect(blocks.find((b) => b.ref === 5)?.href).toBeUndefined()
  })

  it('stop at the cap and say so', () => {
    const many = Array.from({ length: MIRROR_BLOCKS_MAX + 5 }, (_, i) => ({ ref: i, role: 'paragraph' as const, text: `line ${i}` }))
    const { blocks, truncated } = mirrorBlocks(many)
    expect(blocks).toHaveLength(MIRROR_BLOCKS_MAX)
    expect(truncated).toBe(true)
  })

  it('are not truncated when they fit', () => {
    expect(mirrorBlocks([{ ref: 1, role: 'heading', text: 'Hi', level: 1 }])).toEqual({
      blocks: [{ ref: 1, role: 'heading', text: 'Hi', level: 1 }],
      truncated: false
    })
  })
})

describe('a page whose meaning is in pixels', () => {
  it('says so, for canvases and frames', () => {
    expect(pixelOnlyPage(['div', 'canvas'])).toBe(true)
    expect(pixelOnlyPage(['iframe'])).toBe(true)
    expect(pixelOnlyPage(['div', 'p', 'a'])).toBe(false)
  })
})
