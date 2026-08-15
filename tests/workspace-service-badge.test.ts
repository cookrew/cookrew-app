/**
 * Renderer-side projection of WorkspaceMeta.serviceState (v4 §1, VELVET lane).
 * Sol owns the field and the state machine (tests/workspace-service-state.test.ts
 * covers those); this file covers only what the switcher draws — including the
 * defensive path for a payload from a main process older than the field.
 */
import { describe, expect, it } from 'vitest'
import {
  backgroundHotCount,
  serviceBadge,
  serviceStateOf,
  type ServiceState,
  type ServiceStateSource
} from '../src/renderer/src/workspace-service-state'

const ws = (over: Partial<ServiceStateSource> = {}): ServiceStateSource => ({ id: 'w1', ...over })

describe('serviceStateOf', () => {
  it('reads a persisted state for each of the three states', () => {
    for (const state of ['hot', 'dormant', 'parked'] as ServiceState[]) {
      expect(serviceStateOf(ws({ serviceState: state }), false)).toBe(state)
      expect(serviceStateOf(ws({ serviceState: state }), true)).toBe(state)
    }
  })

  it('defaults an unfocused workspace to dormant when the field is absent', () => {
    // An older desktop over the remote API sends no serviceState; dormant is
    // exactly today's behaviour for a background workspace.
    expect(serviceStateOf(ws(), false)).toBe('dormant')
  })

  it('defaults the focused workspace to hot when the field is absent', () => {
    // Focus means attached and syncing, so DORMANT there would report a bug
    // that does not exist. Matches the spec default: focused=hot.
    expect(serviceStateOf(ws(), true)).toBe('hot')
  })

  it('lets a persisted state override the focus-derived default', () => {
    expect(serviceStateOf(ws({ serviceState: 'parked' }), true)).toBe('parked')
    expect(serviceStateOf(ws({ serviceState: 'hot' }), false)).toBe('hot')
  })

  it('falls back rather than trusting a value it does not know', () => {
    // A future state from a newer main process, or a typo — either way this
    // build must not render an unmapped badge.
    expect(serviceStateOf(ws({ serviceState: 'draining' }), false)).toBe('dormant')
    expect(serviceStateOf(ws({ serviceState: 'HOT' }), false)).toBe('dormant')
    expect(serviceStateOf(ws({ serviceState: 'draining' }), true)).toBe('hot')
  })

  it('survives a malformed field instead of throwing at render time', () => {
    for (const bad of [null, undefined, 0, 1, true, {}, ['hot'], NaN]) {
      expect(serviceStateOf(ws({ serviceState: bad }), false)).toBe('dormant')
    }
  })

  it('does not mutate the workspace it reads', () => {
    const w = ws({ serviceState: 'parked' })
    const before = { ...w }
    serviceStateOf(w, true)
    expect(w).toEqual(before)
  })
})

describe('serviceBadge', () => {
  it('gives every state a label, an explanation, and its own state tag', () => {
    for (const state of ['hot', 'dormant', 'parked'] as ServiceState[]) {
      const badge = serviceBadge(state)
      expect(badge.state).toBe(state)
      expect(badge.label).toBe(state.toUpperCase())
      expect(badge.title.length).toBeGreaterThan(0)
    }
  })

  it('mutes only dormant — the unremarkable state', () => {
    expect(serviceBadge('dormant').muted).toBe(true)
    expect(serviceBadge('hot').muted).toBe(false)
    expect(serviceBadge('parked').muted).toBe(false)
  })

  it('explains dormant in terms of work, not UI', () => {
    // The user's question is "will my agent get the message", so the copy has
    // to say sync/dispatch, not "inactive".
    expect(serviceBadge('dormant').title).toMatch(/dispatch/i)
    expect(serviceBadge('hot').title).toMatch(/dispatch/i)
  })
})

describe('backgroundHotCount', () => {
  const list: ServiceStateSource[] = [
    { id: 'a', serviceState: 'hot' },
    { id: 'b', serviceState: 'hot' },
    { id: 'c', serviceState: 'dormant' },
    { id: 'd', serviceState: 'parked' }
  ]

  it('counts hot workspaces that are not the focused one', () => {
    expect(backgroundHotCount(list, 'a')).toBe(1)
    expect(backgroundHotCount(list, 'c')).toBe(2)
  })

  it('is zero when nothing carries the field', () => {
    // The chip must not appear off a defaulted payload: the focused workspace
    // is hot by default but is never counted as background.
    expect(backgroundHotCount([ws({ id: 'a' }), ws({ id: 'b' })], 'a')).toBe(0)
  })

  it('handles an absent active id and an empty list', () => {
    expect(backgroundHotCount([], 'a')).toBe(0)
    expect(backgroundHotCount(list, null)).toBe(2)
    expect(backgroundHotCount(list, undefined)).toBe(2)
  })

  it('never counts a parked or dormant workspace', () => {
    expect(backgroundHotCount([{ id: 'x', serviceState: 'parked' }], 'other')).toBe(0)
    expect(backgroundHotCount([{ id: 'x', serviceState: 'dormant' }], 'other')).toBe(0)
  })
})
