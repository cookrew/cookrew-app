// ACTIVITY IS ONE CLICK FROM THE BAR (owner 2026-11-07: "需要"). It used to be
// ⋯ → Workspaces… → the wall's footer → Activity and history, three clicks and
// a detour through a screen that is not what the reader came for. The ⋯ menu's
// own row opens it; the wall's footer keeps its button for whoever is there.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

describe('the ⋯ menu', () => {
  const more = src('HeaderMore.tsx')

  it('offers Activity as a row of its own, with a label that says what it is', () => {
    expect(more).toContain('onActivity')
    const row = more.slice(more.indexOf('onClick={onActivity}') - 200, more.indexOf('onClick={onActivity}') + 200)
    expect(row).toContain('Activity…')
    expect(row).toContain('Activity and history')
  })

  it('stands it beside Workspaces, before the toggles: the two panels, then the settings', () => {
    expect(more.indexOf('Activity…')).toBeLessThan(more.indexOf('Workspaces…'))
    expect(more.indexOf('Activity…')).toBeGreaterThan(more.indexOf('cr-more-zoom'))
  })

  it('a row closes the menu by the menu’s own rule, so no new close path', () => {
    expect(more.match(/onClick=\{onActivity\}/g)).toHaveLength(1)
  })
})

describe('the bar', () => {
  it('carries onActivity from the app to the menu', () => {
    const header = src('Header.tsx')
    expect(header).toContain('onActivity: () => void')
    expect(header).toContain('onActivity={onActivity}')
  })

  it('the app opens the same panel the wall’s footer does', () => {
    const app = src('App.tsx')
    expect(app).toContain('onActivity={() => setMetricsOpen(true)}')
    expect(app.split('onActivity={() => setMetricsOpen(true)}').length).toBe(2)
  })
})
