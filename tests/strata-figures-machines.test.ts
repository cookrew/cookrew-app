import { describe, expect, it } from 'vitest'
import type { MachineKind, MachineLink } from '../src/shared/strata'
import { desktopFormOf, MACHINE_VIEW, machineArt, portalSkew, stateOf } from '../src/strata/figures/machine'

const KINDS: MachineKind[] = ['laptop', 'desktop', 'server', 'cloud', 'vm', 'cluster', 'sandbox', 'unknown']
const LINKS: MachineLink[] = ['unpaired', 'connecting', 'live', 'offline', 'outdated', 'error']
export const MACHINE_BUDGET = 12 * 1024

describe('machine figures', () => {
  it('draws every kind in every link state within budget, with no ids or refs', () => {
    for (const kind of KINDS) {
      for (const link of LINKS) {
        const art = machineArt({ kind, link })
        expect(art.svg.length, `${kind}/${link}`).toBeLessThanOrEqual(MACHINE_BUDGET)
        expect(art.svg).not.toMatch(/\bid=|url\(|href|<filter|<script|NaN|undefined/)
        expect(art.viewBox).toEqual({ x: 0, y: 0, w: MACHINE_VIEW.w, h: MACHINE_VIEW.h })
      }
    }
  })

  it('is deterministic and memoized by input', () => {
    const a = machineArt({ kind: 'cloud', link: 'live' })
    expect(machineArt({ kind: 'cloud', link: 'live' })).toBe(a)
    expect(JSON.stringify(machineArt({ kind: 'cloud', link: 'offline' }))).toBe(JSON.stringify(machineArt({ kind: 'cloud', link: 'offline' })))
  })

  it('puts the portal inside the frame, on the figure', () => {
    for (const kind of KINDS) {
      const { anchors, viewBox } = machineArt({ kind, link: 'live' })
      const { portal, body } = anchors
      expect(portal.w, kind).toBeGreaterThan(viewBox.w * 0.16)
      expect(portal.x).toBeGreaterThanOrEqual(0)
      expect(portal.y).toBeGreaterThanOrEqual(0)
      expect(portal.x + portal.w).toBeLessThanOrEqual(viewBox.w)
      expect(portal.y + portal.h).toBeLessThanOrEqual(viewBox.h)
      expect(portal.x).toBeGreaterThanOrEqual(body.x - 0.5)
      expect(portalSkew(portal).height, kind).toBeGreaterThan(0)
    }
  })

  it('desaturates an offline machine and outlines one never reached', () => {
    const live = machineArt({ kind: 'server', link: 'live' }).svg
    const offline = machineArt({ kind: 'server', link: 'offline' }).svg
    const never = machineArt({ kind: 'server', link: 'offline', reached: false }).svg
    expect(offline).not.toBe(live)
    expect(live).toContain('#76a0e2')
    expect(offline).not.toContain('#76a0e2')
    expect(never).not.toMatch(/fill="#/)
    expect(never).toContain('stroke-dasharray')
  })

  it('reads the desktop form from the model or label', () => {
    expect(desktopFormOf('Mac mini')).toBe('mini')
    expect(desktopFormOf('Mac14,3')).toBe('mini')
    expect(desktopFormOf(null)).toBe('mini')
    expect(desktopFormOf('Mac Studio')).toBe('mini')
    expect(desktopFormOf('Mac Pro')).toBe('tower')
    expect(desktopFormOf('MacPro7,1')).toBe('tower')
    expect(desktopFormOf('Precision 3660 Tower')).toBe('tower')
    expect(desktopFormOf('iMac (24-inch, 2023)')).toBe('all-in-one')
    expect(desktopFormOf('iMac21,1')).toBe('all-in-one')
  })

  it('draws each desktop form differently, all within budget with a portal', () => {
    const arts = ['Mac mini', 'Mac Studio', 'Mac Pro', 'iMac'].map((model) => machineArt({ kind: 'desktop', link: 'live', model }))
    expect(new Set(arts.map((a) => a.svg)).size).toBe(4)
    for (const art of arts) {
      expect(art.svg.length).toBeLessThanOrEqual(MACHINE_BUDGET)
      expect(art.anchors.portal.w).toBeGreaterThan(art.viewBox.w * 0.16)
    }
    expect(machineArt({ kind: 'desktop', link: 'live' }).svg).toBe(machineArt({ kind: 'desktop', link: 'live', model: 'Mac mini' }).svg)
  })

  it('on any paper: offline recedes by opacity, shadows take the page token', () => {
    const live = machineArt({ kind: 'laptop', link: 'live' }).svg
    expect(live).toContain('var(--cf-shadow,#41538f)')
    expect(live).not.toMatch(/^<svg[^>]*><g opacity/)
    expect(machineArt({ kind: 'laptop', link: 'offline' }).svg).toMatch(/^<svg[^>]*><g opacity="0.78">/)
    expect(machineArt({ kind: 'laptop', link: 'error' }).svg).toMatch(/^<svg[^>]*><g opacity="0.78">/)
  })

  it('reads the link into a state', () => {
    expect(stateOf({ kind: 'laptop', link: 'live' })).toBe('online')
    expect(stateOf({ kind: 'laptop', link: 'offline', reached: false })).toBe('never')
    expect(stateOf({ kind: 'laptop', link: 'live', reached: false })).toBe('online')
    expect(stateOf({ kind: 'laptop', link: 'error' })).toBe('error')
  })

  it('marks unpaired with a padlock and outdated with a sticker', () => {
    const base = machineArt({ kind: 'laptop', link: 'live' }).svg.length
    expect(machineArt({ kind: 'laptop', link: 'unpaired' }).svg.length).toBeGreaterThan(base)
    expect(machineArt({ kind: 'laptop', link: 'outdated' }).svg).toContain('>!</text>')
  })
})
