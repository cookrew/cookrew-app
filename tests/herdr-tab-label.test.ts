import { describe, expect, it } from 'vitest'
import { planTabLabels } from '../src/main/herdr-tab-label'

const AGENT = (pane: string, tab: string, title: string): Record<string, unknown> => ({
  pane_id: pane,
  tab_id: tab,
  title,
  tokens: { cookrew_terminal: `t-${pane}` }
})
const TAB = (tab: string, label: string, paneCount = 1): Record<string, unknown> => ({
  tab_id: tab,
  label,
  pane_count: paneCount
})

describe('planTabLabels — a tab a card has to itself wears the card name', () => {
  it('relabels the tabs that kept another card\'s name (measured live, 2026-11-25)', () => {
    // The Alma service moved the OLD pane out of a shared tab, so the new
    // agent stayed in a tab still named after the pane it was split from.
    const agents = [AGENT('w2:p19D', 'w2:tHZ', 'CI Speed'), AGENT('w2:p1B3', 'w2:tJM', '修复'), AGENT('w2:p1A9', 'w2:tJP', 'Cookrew_dev')]
    const tabs = [TAB('w2:tHZ', 'Relay'), TAB('w2:tJM', 'Cookrew_dev'), TAB('w2:tJP', 'Cookrew_dev')]
    expect(planTabLabels(agents, tabs)).toEqual([
      { tabId: 'w2:tHZ', label: 'CI Speed' },
      { tabId: 'w2:tJM', label: '修复' }
    ])
  })

  it('leaves a shared tab alone — it names none of its panes', () => {
    const agents = [AGENT('w2:p1', 'w2:t1', 'Swap'), AGENT('w2:p2', 'w2:t1', 'Cookrew_dev')]
    expect(planTabLabels(agents, [TAB('w2:t1', 'Cookrew_dev', 2)])).toEqual([])
  })

  it('ignores panes that are not Cookrew cards, and cards with no name', () => {
    const agents = [
      { pane_id: 'w2:p1', tab_id: 'w2:t1', title: 'outsider' },
      AGENT('w2:p2', 'w2:t2', '   '),
      { ...AGENT('w2:p3', 'w2:t3', 'Card'), tab_id: undefined }
    ]
    const tabs = [TAB('w2:t1', 'Shell'), TAB('w2:t2', 'Shell'), TAB('w2:t3', 'Shell')]
    expect(planTabLabels(agents, tabs)).toEqual([])
  })

  it('ignores a tab herdr did not list, and survives garbage entries', () => {
    const agents = [AGENT('w2:p1', 'w2:gone', 'Card'), null, 7] as unknown[]
    const tabs = [null, { label: 'no id', pane_count: 1 }] as unknown[]
    expect(planTabLabels(agents as never, tabs as never)).toEqual([])
  })
})
