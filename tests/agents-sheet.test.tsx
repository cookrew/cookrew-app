// The Agents page's row (AgentsSheet.tsx · AgentRow): what it offers for a
// harness that is missing, signed out, or fine — and what it never offers.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentPageRow } from '../src/shared/agents-page'
import { AgentRow } from '../src/renderer/src/routing/AgentsSheet'

const row = (over: Partial<AgentPageRow> = {}): AgentPageRow => ({
  id: 'agy',
  name: 'Antigravity CLI',
  bin: 'agy',
  command: 'agy --mode accept-edits',
  installed: true,
  signedIn: null,
  version: '1.5.17',
  installLine: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  loginLine: 'agy',
  inDock: true,
  magpieAgent: 'agy',
  note: 'Starts in accept-edits: edits run, shell commands ask.',
  ...over
})

const view = (over: Partial<AgentPageRow> = {}, extras: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(<AgentRow row={row(over)} onRun={vi.fn()} rowsOf={new Map()} onMagpie={vi.fn(async () => undefined)} {...extras} />)

describe('an agent row', () => {
  it('says what it is and whether it is here', () => {
    const html = view()
    expect(html).toContain('Antigravity CLI')
    expect(html).toContain('agy --mode accept-edits')
    expect(html).toContain('v1.5.17')
    expect(html).toContain('INSTALLED')
    expect(html).toContain('IN DOCK')
    expect(html).toContain('accept-edits')
  })

  it('offers Install only for a missing harness, with its install line', () => {
    const html = view({ installed: false, version: null, signedIn: null })
    expect(html).toContain('MISSING')
    expect(html).toContain('Install')
    expect(html).not.toContain('Sign in')
  })

  it('offers Sign in only when it is here and signed out', () => {
    expect(view({ signedIn: false })).toContain('Sign in')
    expect(view({ signedIn: true })).not.toContain('Sign in')
  })

  it("offers Magpie for its model, and the dock for a harness that is not in it", () => {
    expect(view()).toContain('Magpie')
    expect(view({ inDock: false })).not.toContain('Add to dock') // no scan row to add
    const scan = new Map([['agy', { id: 'agy' } as never]])
    expect(view({ inDock: false }, { rowsOf: scan, onAddToDock: vi.fn() })).toContain('Add to dock')
    expect(view({ magpieAgent: null })).not.toContain('Magpie</button>')
  })
})
