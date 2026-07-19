import { describe, expect, it } from 'vitest'
import { activeBrowserTab, noteNameFromContent, browserTabs, uniqueName } from '../src/shared/model'

describe('noteNameFromContent', () => {
  it('slugifies the first line like Maestri', () => {
    expect(noteNameFromContent('Cookrew spec scratchpad — testing note API')).toBe(
      'cookrew-spec-scratchpad-test'
    )
  })

  it('strips markdown markers', () => {
    expect(noteNameFromContent('# Hello World\nbody')).toBe('hello-world')
  })

  it('falls back to untitled for empty content', () => {
    expect(noteNameFromContent('')).toBe('untitled')
    expect(noteNameFromContent('###')).toBe('untitled')
  })

  it('caps length at 28 chars without trailing dash', () => {
    const name = noteNameFromContent('a very long first line that keeps going and going forever')
    expect(name.length).toBeLessThanOrEqual(28)
    expect(name.endsWith('-')).toBe(false)
  })
})

describe('uniqueName', () => {
  it('returns the base when free', () => {
    expect(uniqueName('Scout', [])).toBe('Scout')
  })

  it('appends (2), (3) on collisions', () => {
    expect(uniqueName('Scout', ['Scout'])).toBe('Scout (2)')
    expect(uniqueName('Scout', ['Scout', 'Scout (2)'])).toBe('Scout (3)')
  })
})

describe('browserTabs / activeBrowserTab', () => {
  const base = {
    kind: 'browser' as const,
    id: 'p1',
    name: 'Browser',
    url: 'https://a.example',
    position: { x: 0, y: 0 },
    size: { width: 720, height: 560 }
  }

  it('synthesizes a single tab from url for pre-tabs browsers', () => {
    const tabs = browserTabs(base)
    expect(tabs).toEqual([{ id: 'p1-tab-0', url: 'https://a.example', title: '' }])
    expect(activeBrowserTab(base)).toEqual(tabs[0])
  })

  it('returns stored tabs and resolves the active one', () => {
    const node = {
      ...base,
      tabs: [
        { id: 't1', url: 'https://a.example', title: 'A' },
        { id: 't2', url: 'https://b.example', title: 'B' }
      ],
      activeTabId: 't2'
    }
    expect(browserTabs(node)).toHaveLength(2)
    expect(activeBrowserTab(node).url).toBe('https://b.example')
  })

  it('falls back to the first tab when activeTabId is stale', () => {
    const node = {
      ...base,
      tabs: [{ id: 't1', url: 'https://a.example', title: 'A' }],
      activeTabId: 'gone'
    }
    expect(activeBrowserTab(node).id).toBe('t1')
  })
})
