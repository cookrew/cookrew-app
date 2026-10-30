// THE ZOOMED TERMINAL HAS NO HEAD OF ITS OWN (owner 2026-10-31).
//
// On the phone the zoomed card spent three rows on chrome: its head (name, phase, CHAT/LIVE,
// four icons), a "YOU ❯ <last prompt>" line, and the MDL/EFF/RTE rail. The owner's ruling:
// none of the three; the model switch and CHAT/LIVE go on the top bar, left of ⋯. This holds
// the move — the switch draws as ONE chip, the bar offers the slots, the card fills them — and
// that the head's other buttons were moved into ⋯ rather than lost.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TuneRail } from '../src/renderer/src/nodes/TuneRail'
import { modelSwitchKind } from '../src/renderer/src/zoom-bar'
import { tuneRailView, type AgentTuningState, type TuneRailView } from '../src/shared/agent-tuning'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

function view(): TuneRailView {
  const state: AgentTuningState = {
    harness: 'claude',
    knobs: ['model', 'effort'],
    records: ['model', 'effort'],
    tuning: { model: 'claude-opus-5', effort: 'high', at: 1_759_000_000_000 },
    asks: [],
    caveat: null
  }
  const built = tuneRailView({ state, phase: 'idle', remote: false })
  if (built === null) throw new Error('this fixture must draw a rail')
  return built
}

describe('one switch for the model', () => {
  it('is the route on a routed card and the model on a direct one', () => {
    expect(modelSwitchKind({ routeDial: true, route: 'claude/claude-opus-5-5' })).toBe('route')
    expect(modelSwitchKind({ routeDial: true, route: 'group/smart' })).toBe('route')
    expect(modelSwitchKind({ routeDial: true, route: 'direct' })).toBe('model')
    expect(modelSwitchKind({ routeDial: true, route: null })).toBe('model')
    // No route dial at all (a served session, a bridge without routing): the model.
    expect(modelSwitchKind({ routeDial: false, route: 'group/smart' })).toBe('model')
  })

  it('draws as one chip on the bar — the model dial only, no effort', () => {
    const html = renderToStaticMarkup(
      <TuneRail bar knobs={['model']} view={view()} open={null} onOpen={() => {}} onTurn={() => {}} error={null} />
    )
    expect(html).toContain('cr-tune-rail bar')
    expect(html).toContain('data-knob="model"')
    expect(html).not.toContain('data-knob="effort"')
    expect(html).toContain('aria-label="Model"')
  })

  it('draws the route dial alone for a routed card', () => {
    const html = renderToStaticMarkup(
      <TuneRail
        bar
        knobs={[]}
        view={view()}
        open={null}
        onOpen={() => {}}
        onTurn={() => {}}
        error={null}
        route={{ state: null, choices: ['direct', 'group/smart'], open: false, onOpen: () => {}, onPick: () => {} }}
      />
    )
    expect(html).toContain('data-knob="route"')
    expect(html).not.toContain('data-knob="model"')
    expect(html).not.toContain('data-knob="effort"')
  })

  it('still draws the whole rail where nobody asked for a subset', () => {
    const html = renderToStaticMarkup(<TuneRail view={view()} open={null} onOpen={() => {}} onTurn={() => {}} error={null} />)
    expect(html).toContain('data-knob="model"')
    expect(html).toContain('data-knob="effort"')
    expect(html).not.toContain('cr-tune-rail bar')
  })
})

describe('the bar offers the places, the card fills them', () => {
  const header = src('Header.tsx')
  const more = src('HeaderMore.tsx')
  const overlay = src('TerminalOverlay.tsx')

  it('puts the slot LEFT of ⋯ on the bar', () => {
    const slot = header.indexOf('ref={setZoomBarSlot}')
    const menu = header.indexOf('<HeaderMore')
    expect(slot).toBeGreaterThan(0)
    expect(slot).toBeLessThan(menu)
  })

  it('opens ⋯ with the card’s rows first, and lets them close it', () => {
    expect(more).toContain('ref={setZoomMenuSlot}')
    expect(more.indexOf('ref={setZoomMenuSlot}')).toBeLessThan(more.indexOf('{connection && ('))
    expect(more).toContain('registerZoomMenuClose(close)')
  })

  it('draws no head on a surface that has the bar — only the embed keeps a slim row', () => {
    expect(overlay).not.toMatch(/<div className="popout-header">/)
    expect(overlay).toContain('zoomSlots.bar === null && (\n        <div className="popout-header slim">')
    expect(overlay).toContain('createPortal(barContent, zoomSlots.bar)')
  })

  it('moves CHAT/LIVE and the model switch into the bar content, together', () => {
    const bar = overlay.slice(overlay.indexOf('const barContent = ('), overlay.indexOf('const barContent = (') + 2500)
    expect(bar).toContain('<TuneRail')
    expect(bar).toContain("knobs={switchKind === 'route' ? [] : ['model']}")
    expect(bar).toContain("(['chat', 'live'] as const)")
  })

  it('keeps translate, titles, back and close — in ⋯, not deleted', () => {
    const menu = overlay.slice(overlay.indexOf('zoomSlots.menu !== null &&'))
    for (const row of ['<TranslateButton', 'toggleTitleMode()', 'zoomBack()', 'requestClose(node.id)']) expect(menu).toContain(row)
    expect(menu).toContain('closeZoomMenu()')
  })

  it('shows the "YOU ❯" line no more; a picked checkpoint keeps its row, the way back to live', () => {
    expect(overlay).toContain('{selectedIndex !== null && (\n        <div className="popout-ask"')
    expect(overlay).not.toContain('(selectedIndex !== null || activity?.prompt) && (')
  })

  it('takes the rail out of the left column, which keeps the side tabs', () => {
    const side = overlay.slice(overlay.indexOf('<div className="popout-terminal-wrap">'), overlay.indexOf('<div ref={mainRef}'))
    expect(side).not.toContain('<TuneRail')
    expect(side).toContain('<AttachTabs')
  })

  it('lets only the primary overlay take the bar when several are mounted', () => {
    expect(overlay).toContain('{primary && zoomSlots.bar !== null && createPortal(barContent, zoomSlots.bar)}')
    expect(overlay).toContain('{primary && zoomSlots.menu !== null &&')
  })
})
