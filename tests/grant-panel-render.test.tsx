import { describe, expect, it, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GrantPanel } from '../src/renderer/src/GrantPanel'
import { EnrolSheet } from '../src/renderer/src/EnrolSheet'
import { ExportToggle } from '../src/renderer/src/ExportToggle'
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

describe('the export entry point paints on the agent row', () => {
  const toggle = (state: Parameters<typeof ExportToggle>[0]['state']): string =>
    renderToStaticMarkup(
      <ExportToggle
        agentName="Forge"
        state={state}
        onExport={() => undefined}
        onUnexport={() => undefined}
        onOpenGrants={() => undefined}
      />
    )

  it('offers the invitation and STATES THE GUARANTEE while off', () => {
    // The moment the fear is live. Velvet's sentence 6 is on screen, as prose,
    // before the author has committed to anything.
    const html = toggle({ exportable: false, callers: 0, inFlight: 0 })
    expect(html).toContain('Let people call this agent')
    expect(html).toContain('never touched, never sent, and never resumed by anyone else')
    expect(html).toContain('Not exportable')
  })

  it('answers "who can call this" at rest once it is on', () => {
    const html = toggle({ exportable: true, callers: 0, inFlight: 0 })
    expect(html).toContain('Nobody can call this')
    expect(html).toContain('WHO CAN CALL')
    // And says what is NOT built rather than implying a publish flow exists.
    expect(html).toContain('isn’t built yet')
  })

  it('counts callers and shows live calls without opening anything', () => {
    const html = toggle({ exportable: true, callers: 2, inFlight: 1 })
    expect(html).toContain('2 callers')
    expect(html).toContain('1 calling now')
  })

  it('shows a failure beside the control that produced it', () => {
    const html = renderToStaticMarkup(
      <ExportToggle
        agentName="Forge"
        state={{ exportable: true, callers: 1, inFlight: 0 }}
        error="Couldn’t stop exporting Forge — it is still exportable."
        onExport={() => undefined}
        onUnexport={() => undefined}
        onOpenGrants={() => undefined}
      />
    )
    expect(html).toContain('still exportable')
    expect(html).toContain('role="alert"')
  })

  it('disables while in flight, so one press cannot become two', () => {
    const html = renderToStaticMarkup(
      <ExportToggle
        agentName="Forge"
        state={{ exportable: false, callers: 0, inFlight: 0 }}
        busy
        onExport={() => undefined}
        onUnexport={() => undefined}
        onOpenGrants={() => undefined}
      />
    )
    expect(html).toMatch(/<button[^>]*class="ex-invite"[^>]*disabled/)
  })

  it('renders NOTHING when the roster could not be read', () => {
    // Never a default of "not exportable" — that would tell an author their
    // agent is private when it may be reachable.
    expect(toggle(null)).toBe('')
  })
})
