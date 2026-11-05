// A BROWSER'S SITES IN THE SEARCH RESULTS (owner 2026-11-03: show the URL).
// Every site of a card is a title over its whole address; the sites a word
// landed on come first, the showing one first among them; the words marked.
import { describe, expect, it } from 'vitest'
import { markParts, readableUrl, siteLines } from '../src/renderer/src/site-lines'
import type { BrowserNodeData } from '../src/shared/model'

const at = { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
const card = (tabs: { url: string; title: string }[], active = 0): BrowserNodeData => ({
  kind: 'browser',
  id: 'b',
  name: 'Launch research',
  url: tabs[active].url,
  tabs: tabs.map((t, i) => ({ id: `t${i}`, ...t })),
  activeTabId: `t${active}`,
  ...at,
})
const text = (parts: { text: string }[]): string => parts.map((p) => p.text).join('')
const marked = (parts: { text: string; mark: boolean }[]): string[] => parts.filter((p) => p.mark).map((p) => p.text)

const four = card(
  [
    { url: 'https://www.xiaohongshu.com/explore/123', title: '小红书 - 你的生活指南' },
    { url: 'https://github.com/cookrew/app/issues/42', title: 'Board search · Issue #42' },
    { url: 'http://localhost:5173/zoom?seed=crew', title: '' },
    { url: 'https://figma.com/file/pivot', title: 'Pivot — Figma' },
  ],
  1,
)

describe('which sites the row shows', () => {
  it('shows the whole address of each, not cut after a title', () => {
    const { lines } = siteLines(four, 'github')
    expect(text(lines[0].url)).toBe('https://github.com/cookrew/app/issues/42')
    expect(text(lines[0].title)).toBe('Board search · Issue #42')
  })

  it('puts the sites a word landed on first, the showing one first among them', () => {
    expect(siteLines(four, 'localhost').lines.map((l) => l.id)).toEqual(['t2', 't1', 't0'])
    expect(siteLines(four, 'https').lines.map((l) => l.id)).toEqual(['t1', 't0', 't3'])
  })

  it('shows three and counts the rest', () => {
    expect(siteLines(four, 'github').hidden).toBe(1)
    expect(siteLines(card([{ url: 'https://a.com', title: 'A' }]), 'a').hidden).toBe(0)
  })

  it('says which site a word landed on', () => {
    const { lines } = siteLines(four, 'figma')
    expect(lines[0]).toMatchObject({ id: 't3', hit: true })
    expect(lines.slice(1).every((l) => !l.hit)).toBe(true)
  })

  it('gives a site never loaded its address alone', () => {
    const line = siteLines(four, 'seed').lines[0]
    expect(line.title).toEqual([])
    expect(marked(line.url)).toEqual(['seed'])
  })
})

describe('the marks', () => {
  it('mark every word wherever it is, whatever its case', () => {
    expect(marked(markParts('Board search · Issue #42 — board', ['board', '42']))).toEqual(['Board', '42', 'board'])
  })

  it('keep the text whole', () => {
    expect(text(markParts('github.com/cookrew', ['git', 'cook']))).toBe('github.com/cookrew')
  })

  it('cover a longer word over a shorter one inside it', () => {
    expect(marked(markParts('cookrew', ['cook', 'cookrew']))).toEqual(['cookrew'])
  })
})

describe('the address as read', () => {
  it('decodes %-escapes, and keeps an address that will not decode', () => {
    expect(readableUrl('https://x.com/%E5%B0%8F%E7%BA%A2%E4%B9%A6')).toBe('https://x.com/小红书')
    expect(readableUrl('https://x.com/%E5')).toBe('https://x.com/%E5')
  })
})
