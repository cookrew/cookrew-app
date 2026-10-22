import { describe, expect, it } from 'vitest'
import type { AgentPhase, Harness, PhaseSource } from '../src/shared/strata'
import { avatarArt, AVATAR_VIEW, BALL, cardArt, colorFigures, containerArt } from '../src/strata/figures'
import type { AvatarSize } from '../src/strata/seams'

export const AVATAR_BUDGET = 1.5 * 1024
const PHASES: AgentPhase[] = ['idle', 'thinking', 'waiting', 'replied', 'offline']
const SOURCES: PhaseSource[] = ['live', 'probe', 'ledger']
const HARNESSES: Harness[] = ['claude', 'codex', 'opencode', 'pi', 'shell', 'other']
const SIZES: AvatarSize[] = ['dot', 'small', 'full']

const all = () =>
  SIZES.flatMap((size) => PHASES.flatMap((phase) => SOURCES.flatMap((source) => HARNESSES.map((harness) => ({ size, phase, source, harness })))))

describe('avatars', () => {
  it('draws every phase, source, harness and size within budget, with no ids or refs', () => {
    for (const input of all()) {
      const art = avatarArt(input)
      expect(art.svg.length, JSON.stringify(input)).toBeLessThanOrEqual(AVATAR_BUDGET)
      expect(art.svg).not.toMatch(/\bid=|url\(|href|<filter|<script|NaN|undefined/)
      expect(art.viewBox.w).toBe(AVATAR_VIEW[input.size])
    }
  })

  it('is one size of ball per size, laid out like a seat', () => {
    for (const size of SIZES) {
      const radii = new Set(PHASES.map((phase) => avatarArt({ phase, source: 'live', harness: 'claude', size }).svg.match(/<circle [^>]*r="([\d.]+)" stroke="currentColor"/)?.[1]))
      expect(radii.size, size).toBe(1)
    }
    const slot = containerArt({ name: 'Paper Notes', slots: 3 }).anchors['slot:0']
    expect(slot.w).toBeCloseTo(slot.h)
    expect(BALL.cx).toBe(0.5)
  })

  it('moves only the thinking ring and the waiting flag, and only when live', () => {
    const moving = (phase: AgentPhase, source: PhaseSource = 'live') =>
      /<animate/.test(avatarArt({ phase, source, harness: 'claude', size: 'full' }).svg)
    expect(moving('thinking')).toBe(true)
    expect(moving('waiting')).toBe(true)
    expect(moving('idle')).toBe(false)
    expect(moving('replied')).toBe(false)
    expect(moving('offline')).toBe(false)
    expect(moving('thinking', 'probe')).toBe(false)
    expect(moving('waiting', 'ledger')).toBe(false)
  })

  it('draws a guess visibly less certain than a fact', () => {
    const live = avatarArt({ phase: 'waiting', source: 'live', harness: 'codex', size: 'small' }).svg
    const probe = avatarArt({ phase: 'waiting', source: 'probe', harness: 'codex', size: 'small' }).svg
    expect(live).not.toContain('stroke-dasharray')
    expect(probe).toContain('stroke-dasharray')
  })

  it('never paints idle green, and marks replied with a green dot', () => {
    const idle = avatarArt({ phase: 'idle', source: 'live', harness: 'shell', size: 'full' }).svg
    expect(idle).not.toContain('#43c25c')
    expect(avatarArt({ phase: 'replied', source: 'live', harness: 'shell', size: 'dot' }).svg).toContain('#43c25c')
  })

  it('tells thinking from idle even at dot size', () => {
    const dot = (phase: AgentPhase) => avatarArt({ phase, source: 'live', harness: 'claude', size: 'dot' }).svg
    expect(dot('thinking')).not.toBe(dot('idle'))
  })

  it('draws values it does not know as neutral ones, never "undefined"', () => {
    const odd = avatarArt({ phase: 'dreaming', source: 'rumour', harness: 'aider', size: 'huge' } as never)
    expect(odd.svg).not.toMatch(/undefined|NaN/)
    expect(odd.svg).toBe(avatarArt({ phase: 'idle', source: 'probe', harness: 'other', size: 'small' }).svg)
  })

  it('reads on dark paper: guesses and offline recede by opacity, shadows take the page token, the pole is inked', () => {
    const live = avatarArt({ phase: 'idle', source: 'live', harness: 'claude', size: 'full' }).svg
    const probe = avatarArt({ phase: 'idle', source: 'probe', harness: 'claude', size: 'full' }).svg
    const offline = avatarArt({ phase: 'offline', source: 'live', harness: 'claude', size: 'full' }).svg
    expect(live).not.toContain('<g opacity')
    expect(probe).toContain('<g opacity="0.60">')
    expect(offline).toContain('<g opacity="0.72">')
    expect(live).toContain('var(--cf-shadow,#41538f)')
    expect(avatarArt({ phase: 'waiting', source: 'live', harness: 'claude', size: 'full' }).svg).toMatch(/<path d="M[^"]+" stroke="currentColor"/)
  })

  it('exposes badge and fan anchors inside the viewBox', () => {
    const { anchors, viewBox } = avatarArt({ phase: 'idle', source: 'live', harness: 'pi', size: 'full' })
    for (const key of ['badge', 'fan']) {
      expect(anchors[key].x).toBeGreaterThanOrEqual(0)
      expect(anchors[key].y).toBeGreaterThanOrEqual(0)
      expect(anchors[key].x + anchors[key].w).toBeLessThanOrEqual(viewBox.w)
    }
  })
})

describe('attachment cards and the kit', () => {
  it('draws notes and browsers, shared or not, with no ids or refs', () => {
    for (const kind of ['note', 'browser'] as const) {
      for (const shared of [false, true]) {
        const { svg } = cardArt({ kind, shared })
        expect(svg.length).toBeLessThanOrEqual(AVATAR_BUDGET)
        expect(svg).not.toMatch(/\bid=|url\(|href/)
      }
    }
    expect(cardArt({ kind: 'note', shared: true }).svg).not.toBe(cardArt({ kind: 'note', shared: false }).svg)
  })

  it('implements FigureKit with memoized output', () => {
    expect(colorFigures.avatar({ phase: 'idle', source: 'live', harness: 'claude', size: 'small' })).toBe(
      colorFigures.avatar({ phase: 'idle', source: 'live', harness: 'claude', size: 'small' })
    )
    expect(colorFigures.machine({ kind: 'laptop', link: 'live' }).anchors.portal).toBeDefined()
    expect(colorFigures.container({ name: 'Monorepo', slots: 3 }).archetype).toBe('workbench')
    expect(colorFigures.attachment({ kind: 'browser', shared: false }).viewBox.w).toBe(48)
  })
})
