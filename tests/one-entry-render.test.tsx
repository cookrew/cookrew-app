import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ShareOnSave,
  canSubmitShare,
  priceLooksGood,
  saveButtonLabel,
  type ShareAccess
} from '../src/renderer/src/ShareOnSave'
import { ServedTeamCard, type ServedTeam } from '../src/renderer/src/ServedTeamCard'
import { AddCrewSheet } from '../src/renderer/src/AddCrewSheet'

/**
 * THE ONE-ENTRY SURFACES render, and say the things the ruling requires.
 *
 * The cheapest half of "it is tappable on the card": a surface that throws on
 * first paint wastes a whole QA pass. These also pin the two claims the design
 * turns on — the primary renames when the click gains a consequence, and the
 * door fact appears only when a door is actually opening.
 */

const noop = (): void => undefined
const src = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src/renderer/src', file), 'utf8')

const paint = (access: ShareAccess, priceUsd = ''): string =>
  renderToStaticMarkup(
    <ShareOnSave access={access} priceUsd={priceUsd} door="Conductor" onAccess={noop} onPrice={noop} />
  )

describe('ShareOnSave — the share question inside the save sheet', () => {
  it('offers exactly the three doors, private first', () => {
    const html = paint('just-me')
    expect(html).toContain('Just me')
    expect(html).toContain('Anyone with a Cookrew account')
    expect(html).toContain('Anyone who pays')
  })

  it('shows NO door fact while the team stays private', () => {
    // Before a door opens it is noise; it answers a fear nobody has yet.
    expect(paint('just-me')).not.toContain('Callers talk to')
  })

  it('shows the door fact the moment a public option is picked', () => {
    for (const access of ['account', 'paid'] as const) {
      expect(paint(access)).toContain('Callers talk to Conductor only')
    }
  })

  it('asks for a price only on the paid door, per SESSION', () => {
    expect(paint('account')).not.toContain('per session')
    expect(paint('paid', '2.50')).toContain('USDC · per session')
  })

  it('says why a bad price is bad rather than silently refusing', () => {
    expect(paint('paid', 'abc')).toContain('a number above zero')
    expect(paint('paid', '2.50')).not.toContain('a number above zero')
  })

  it('carries the NARROWED privacy claim, never the old over-promise', () => {
    // The R30 ruling: the owner CAN read a caller's session, so the copy
    // promises identity only.
    const html = paint('account')
    expect(html).toContain('They sign in, then start.')
    expect(html).not.toContain('never what they are doing')
  })
})

describe('the primary says everything the click does', () => {
  it('stays a plain SAVE while nothing is published', () => {
    expect(saveButtonLabel('just-me', false)).toBe('SAVE')
  })

  it('renames when the click also opens a door', () => {
    expect(saveButtonLabel('account', false)).toBe('SAVE · START SERVING')
    expect(saveButtonLabel('paid', false)).toBe('SAVE · START SERVING')
  })

  it('cannot submit a paid door that could not quote at 402', () => {
    expect(canSubmitShare('paid', '')).toBe(false)
    expect(canSubmitShare('paid', '0')).toBe(false)
    expect(canSubmitShare('paid', '2.50')).toBe(true)
    // A free door never blocks on a price it does not have.
    expect(canSubmitShare('just-me', '')).toBe(true)
    expect(canSubmitShare('account', '')).toBe(true)
  })

  it('agrees with the backend on what a price is', () => {
    // Mirrors validPrice in session-served.ts — a UI that accepted what the
    // main process refuses would fail at the worst moment.
    expect(priceLooksGood('2.50')).toBe(true)
    expect(priceLooksGood('10')).toBe(true)
    expect(['0', '-1', 'abc', '', '1.234'].every((v) => !priceLooksGood(v))).toBe(true)
  })
})

describe('ServedTeamCard — who is on, on the thing you published', () => {
  const team: ServedTeam = {
    serviceId: 'svc-research-crew',
    templateId: 'Research Crew',
    slug: 'research-crew',
    access: 'paid',
    priceUsd: '2.50',
    address: 'http://192.168.1.20:8639/research-crew'
  }

  it('leads with the address, because that is the thing you hand over', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard team={team} door="Conductor" onStopped={noop} onClose={noop} />
    )
    expect(html).toContain('http://192.168.1.20:8639/research-crew')
    expect(html).toContain('COPY LINK')
    expect(html).toContain('Research Crew is taking calls.')
  })

  it('names the door and the price on one line', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard team={team} door="Conductor" onStopped={noop} onClose={noop} />
    )
    expect(html).toContain('Callers land on Conductor')
    expect(html).toContain('2.50 USDC · per session')
  })

  it('offers STOP SERVING and reassures the owner they can carry on', () => {
    const html = renderToStaticMarkup(
      <ServedTeamCard team={team} door="Conductor" onStopped={noop} onClose={noop} />
    )
    expect(html).toContain('STOP SERVING')
    expect(html).toContain('Keep working exactly as you did before')
  })
})

describe('AddCrewSheet — adding is free and inert', () => {
  it('paints, and asks only for the address', () => {
    const html = renderToStaticMarkup(<AddCrewSheet onClose={noop} onAdded={noop} />)
    expect(html).toContain('Add a crew')
    expect(html).toContain('ADD TO DOCK')
    expect(html).toContain('Paste the address')
  })

  it('the primary is disabled until something is pasted', () => {
    expect(renderToStaticMarkup(<AddCrewSheet onClose={noop} onAdded={noop} />)).toContain('disabled')
  })
})

describe('the retirements are real, not merely unmounted', () => {
  it('no per-agent export toggle survives on a roster row', () => {
    const row = src('AgentRow.tsx')
    expect(row).not.toContain('<ExportToggle')
    expect(row).not.toContain("from './ExportToggle'")
  })

  it('the dock offers crews and a way to add one', () => {
    const dock = src('Dock.tsx')
    expect(dock).toContain('crew-chip')
    expect(dock).toContain('+ ADD BY LINK')
  })
})
