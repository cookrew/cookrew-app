/**
 * HERDR'S TAB LABELS follow the card (2026-11-25): a tab a Cookrew pane has
 * to itself wears that card's name, the way its pane title and agent name do.
 *
 * Measured live: tabs labelled "Relay" held CI Speed, Remote Desktop and
 * Theme System, and four tabs labelled "Cookrew_dev" held four different
 * cards. Panes used to be SPLIT off whichever pane herdr had focused, and the
 * Alma service (~/.cookrew/alma-herdr/service.sh) then moved the FIRST pane
 * of each crowded tab — the old, focused one — into a fresh tab labelled
 * after it. The new card stayed behind in a tab named after its neighbour,
 * and a tab was only ever relabelled on a rename.
 *
 * Pure: one `agent list` and one `tab list` in, the renames out.
 */
import type { ListedAgent } from './herdr-agent-name'

/** A tab as `herdr tab list` reports it. Only the fields read here. */
export interface ListedTab {
  tab_id?: string | null
  label?: string | null
  pane_count?: number | null
}

export interface TabLabelChange {
  tabId: string
  label: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** The card name a Cookrew pane wears (reportPaneCard's title), or null. */
function cardName(agent: ListedAgent): string | null {
  if (typeof agent.tokens?.cookrew_terminal !== 'string') return null
  const title = typeof agent.title === 'string' ? agent.title.trim() : ''
  return title === '' ? null : title
}

/**
 * Every tab holding exactly one pane, that pane a Cookrew card's, whose label
 * is not the card's name. A shared tab names none of its panes (renameTab).
 */
export function planTabLabels(agents: readonly ListedAgent[], tabs: readonly ListedTab[]): TabLabelChange[] {
  const alone = new Map<string, string | null>()
  for (const tab of tabs) {
    if (!isObject(tab) || typeof tab.tab_id !== 'string' || tab.pane_count !== 1) continue
    alone.set(tab.tab_id, typeof tab.label === 'string' ? tab.label : null)
  }
  const changes: TabLabelChange[] = []
  const planned = new Set<string>()
  for (const agent of agents) {
    if (!isObject(agent) || typeof agent.tab_id !== 'string') continue
    const label = cardName(agent)
    const tabId = agent.tab_id
    if (label === null || !alone.has(tabId) || planned.has(tabId)) continue
    if (alone.get(tabId) === label) continue
    planned.add(tabId)
    changes.push({ tabId, label })
  }
  return changes
}
