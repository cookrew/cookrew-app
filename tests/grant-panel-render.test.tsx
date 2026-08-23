import { describe, expect, it, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GrantPanel } from '../src/renderer/src/GrantPanel'
import { EnrolSheet } from '../src/renderer/src/EnrolSheet'
import type { GrantRoster } from '../src/main/grant-roster'

/**
 * THE PANEL RENDERS — the cheapest half of "it is tappable on the card".
 *
 * Magpie drives the real surface; this cannot replace that and does not try.
 * What it does catch is the failure that would waste her entire pass: a panel
 * that throws on first paint, so the reviewer pretending to know nothing meets
 * a blank screen and reports the feature missing. A static render runs the
 * component body, the JSX and every branch reachable without effects.
 */

const roster = (over: Partial<GrantRoster> = {}): GrantRoster => ({
  workspaceId: 'w1',
  callers: [],
  agents: [],
  revoked: [],
  live: [],
  ...over
})

function stubBridge(next: GrantRoster): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      grantList: async () => next,
      grantEnrol: async () => ({ ok: true }),
      grantRevoke: async () => ({ ok: true, stopped: 0 }),
      grantExport: async () => ({ ok: true }),
      grantUnexport: async () => ({ ok: true }),
      grantRestore: async () => ({ ok: true })
    }
  }
}

const paint = (r: GrantRoster): string => {
  stubBridge(r)
  return renderToStaticMarkup(
    <GrantPanel workspace={null} workspaceId="w1" onClose={() => undefined} />
  )
}

describe('the WHO CAN CALL panel paints', () => {
  beforeEach(() => stubBridge(roster()))

  it('renders at all, with the owner bridge present', () => {
    const html = paint(roster())
    expect(html).toContain('Who can call')
    expect(html).toContain('ENROL A CALLER')
  })

  it('renders NOTHING without the owner bridge — absence, not a disabled panel', () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = { cookrew: {} }
    const html = renderToStaticMarkup(
      <GrantPanel workspace={null} workspaceId="w1" onClose={() => undefined} />
    )
    expect(html).toBe('')
  })

  it('leads a first-time owner to the first step, not into an empty table', () => {
    // What Magpie meets knowing nothing: no agents exportable yet.
    const html = paint(roster())
    expect(html).toContain('No agents are exportable')
    expect(html).toContain('mkt.grant.empty.noexport')
  })

  it('paints its FIRST frame before the roster arrives, without throwing', () => {
    // The honest limit of this technique: renderToStaticMarkup does not run
    // effects, so the roster is still null here. That is worth asserting rather
    // than working around — first paint is exactly what a reviewer opening the
    // panel sees, and it must be the teaching empty state and not a blank box
    // or a crash. Which empty state follows from which roster is decided by
    // emptyStateFor and asserted in tests/grant-surface-ui.test.ts.
    const html = paint(roster({ agents: [{ nodeId: 'node-forge', callers: [], inFlight: 0 }] }))
    expect(html).toContain('Who can call')
    expect(html).toContain('mkt.grant.empty.noexport')
  })

  it('the enrol sheet paints, and its primary is disabled before a key is pasted', () => {
    const html = renderToStaticMarkup(
      <EnrolSheet onEnrol={() => undefined} onClose={() => undefined} />
    )
    expect(html).toContain('I COMPARED THESE · ENROL')
    expect(html).toContain('Enrol a caller')
    // Nothing pasted, nothing named — the attestation cannot be made yet.
    expect(html).toMatch(/<button[^>]*class="gs-primary"[^>]*disabled/)
    // And the sheet is not a form, so Enter has nothing to submit.
    expect(html).not.toContain('<form')
  })
})
