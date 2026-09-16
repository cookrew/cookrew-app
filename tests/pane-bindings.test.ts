import { describe, expect, it } from 'vitest'
import {
  paneCardFor,
  reportAllPaneBindings,
  type BindableTerminal,
  type PaneBindingDeps
} from '../src/main/pane-bindings'
import type { PaneCardInfo } from '../src/main/multiplexer'

/**
 * MEASURED across the herdr 0.8.2 -> 0.9.0 live handoff on 2026-09-10: 33 of
 * 56 panes carried a title before the server was replaced and 5 after, because
 * the binding is only re-reported for terminals this process ATTACHES. Every
 * agent kept running; herdr's sidebar and every title-keyed tool simply could
 * not find them.
 */

const terminal = (over: Partial<BindableTerminal> = {}): BindableTerminal => ({
  id: '7d4ff650-a24b-4b88-b382-2c06e1b99c92',
  name: 'Forge',
  role: 'Developer',
  preset: 'Claude Code',
  cwd: '/Users/drej/workspace/cookrew-dev',
  ...over
})

const spy = (
  terminals: readonly BindableTerminal[],
  over: Partial<PaneBindingDeps> = {}
): {
  deps: PaneBindingDeps
  reported: { sessionName: string; card: PaneCardInfo }[]
  order: string[]
} => {
  const reported: { sessionName: string; card: PaneCardInfo }[] = []
  const order: string[] = []
  const deps: PaneBindingDeps = {
    terminals: () => terminals,
    workspaceOf: (id) => (id.startsWith('7d4') ? 'Cookrew Dev' : 'Baymax Home'),
    sessionName: (id) => `cookrew_${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`,
    report: (sessionName, card) => {
      order.push('report')
      reported.push({ sessionName, card })
    },
    beginBatch: () => void order.push('begin'),
    endBatch: () => void order.push('end'),
    ...over
  }
  return { deps, reported, order }
}

describe('paneCardFor', () => {
  it('is the node’s name, its role and its OWN workspace', () => {
    expect(paneCardFor(terminal(), 'Cookrew Dev')).toEqual({
      terminalId: '7d4ff650-a24b-4b88-b382-2c06e1b99c92',
      title: 'Forge',
      agent: 'Developer',
      workspace: 'Cookrew Dev',
      cwd: '/Users/drej/workspace/cookrew-dev'
    })
  })

  it('falls back to the preset when the card has no role', () => {
    expect(paneCardFor(terminal({ role: null }), 'Cookrew Dev').agent).toBe('Claude Code')
  })
})

describe('reportAllPaneBindings', () => {
  it('names every terminal, each under the workspace that owns it', () => {
    const { deps, reported } = spy([
      terminal(),
      terminal({ id: 'b395b211-3802-45f6-84b1-6c1600000000', name: 'Homelab CC', role: null })
    ])
    expect(reportAllPaneBindings(deps)).toBe(2)
    expect(reported.map((r) => [r.sessionName, r.card.title, r.card.workspace])).toEqual([
      ['cookrew_7d4ff650a24b4b88b3822c06', 'Forge', 'Cookrew Dev'],
      ['cookrew_b395b211380245f684b16c16', 'Homelab CC', 'Baymax Home']
    ])
  })

  it('takes ONE pane listing for the whole sweep', () => {
    const { deps, order } = spy([terminal(), terminal({ id: 'a' }), terminal({ id: 'b' })])
    reportAllPaneBindings(deps)
    expect(order).toEqual(['begin', 'report', 'report', 'report', 'end'])
  })

  it('a pane that cannot be named does not stop the rest, and the batch still closes', () => {
    const { deps, order } = spy([terminal({ id: 'a' }), terminal({ id: 'b' }), terminal({ id: 'c' })], {
      report: (sessionName) => {
        order.push('report')
        if (sessionName === 'cookrew_b') throw new Error('herdr said no')
      }
    })
    expect(reportAllPaneBindings(deps)).toBe(2)
    expect(order.at(-1)).toBe('end')
  })

  it('closes the batch when the terminal list itself throws', () => {
    const { deps, order } = spy([], {
      terminals: () => {
        throw new Error('workspace.json is corrupt')
      }
    })
    expect(() => reportAllPaneBindings(deps)).toThrow('workspace.json is corrupt')
    expect(order).toEqual(['begin', 'end'])
  })

  it('works against a backend with no batch of its own', () => {
    const { deps, reported } = spy([terminal()], { beginBatch: undefined, endBatch: undefined })
    expect(reportAllPaneBindings(deps)).toBe(1)
    expect(reported).toHaveLength(1)
  })
})
