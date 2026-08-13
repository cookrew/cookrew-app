import { describe, expect, it } from 'vitest'
import { browserInFullView } from '../src/renderer/src/dock-target'
import type { BrowserNodeData } from '../src/shared/model'

const browser = (over: Partial<BrowserNodeData> = {}): BrowserNodeData =>
  ({
    id: 'b1',
    kind: 'browser',
    name: 'Recon',
    url: 'https://example.com/opened-on',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    ...over
  }) as BrowserNodeData

describe('browserInFullView', () => {
  it('is null when nothing fills the stage', () => {
    expect(browserInFullView(null, [browser()])).toBeNull()
  })

  it('is null when the card in full view is not a browser', () => {
    expect(browserInFullView('terminal-7', [browser()])).toBeNull()
  })

  it('targets the browser filling the stage', () => {
    expect(browserInFullView('b1', [browser()])).toEqual({
      id: 'b1',
      url: 'https://example.com/opened-on'
    })
  })

  // The dock hands off the page you are LOOKING at, not the one the card
  // was created with — otherwise every tab beyond the first opens wrong.
  it('reports the active tab url, not the url the card opened on', () => {
    const node = browser({
      tabs: [
        { id: 't1', url: 'https://example.com/opened-on', title: '' },
        { id: 't2', url: 'https://github.com/cookrew', title: '' }
      ],
      activeTabId: 't2'
    })
    expect(browserInFullView('b1', [node])?.url).toBe('https://github.com/cookrew')
  })
})
