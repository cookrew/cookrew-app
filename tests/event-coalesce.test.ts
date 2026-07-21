import { describe, expect, it } from 'vitest'
import { coalesceIndex, eventMeta, COALESCE_MS } from '../src/renderer/src/event-log'

type Toast = { type: string; workspaceId: string; lastAt: number; leaving: boolean }

const toast = (over: Partial<Toast> = {}): Toast => ({
  type: 'terminal.recruited',
  workspaceId: 'ws1',
  lastAt: 1000,
  leaving: false,
  ...over
})

describe('coalesceIndex — burst coalescing (projection A)', () => {
  it('merges same type+workspace within the window', () => {
    const idx = coalesceIndex([toast()], { type: 'terminal.recruited', workspaceId: 'ws1' }, 1500)
    expect(idx).toBe(0)
  })

  it('does not merge once the window has elapsed', () => {
    const idx = coalesceIndex(
      [toast({ lastAt: 1000 })],
      { type: 'terminal.recruited', workspaceId: 'ws1' },
      1000 + COALESCE_MS + 1
    )
    expect(idx).toBe(-1)
  })

  it('keeps different types separate', () => {
    const idx = coalesceIndex([toast()], { type: 'note.created', workspaceId: 'ws1' }, 1500)
    expect(idx).toBe(-1)
  })

  it('keeps different workspaces separate', () => {
    const idx = coalesceIndex([toast()], { type: 'terminal.recruited', workspaceId: 'ws2' }, 1500)
    expect(idx).toBe(-1)
  })

  it('never merges into a leaving toast', () => {
    const idx = coalesceIndex(
      [toast({ leaving: true })],
      { type: 'terminal.recruited', workspaceId: 'ws1' },
      1500
    )
    expect(idx).toBe(-1)
  })

  it('collapses a team-fork burst of 11 into one grouped toast', () => {
    // Simulate 11 rapid recruits arriving 100ms apart, each rolling the
    // window forward — they all merge into the single first toast.
    let toasts: Toast[] = []
    let merges = 0
    for (let i = 0; i < 11; i++) {
      const now = 1000 + i * 100
      const idx = coalesceIndex(toasts, { type: 'terminal.recruited', workspaceId: 'ws1' }, now)
      if (idx >= 0) {
        toasts[idx] = { ...toasts[idx], lastAt: now }
        merges++
      } else {
        toasts = [{ type: 'terminal.recruited', workspaceId: 'ws1', lastAt: now, leaving: false }]
      }
    }
    expect(toasts).toHaveLength(1)
    expect(merges).toBe(10) // first creates, next 10 merge → count 11
  })

  it('a slow drip past the window starts fresh toasts', () => {
    let toasts: Toast[] = []
    let created = 0
    for (let i = 0; i < 3; i++) {
      const now = 1000 + i * (COALESCE_MS + 500)
      const idx = coalesceIndex(toasts, { type: 'terminal.recruited', workspaceId: 'ws1' }, now)
      if (idx >= 0) toasts[idx] = { ...toasts[idx], lastAt: now }
      else {
        toasts = [{ type: 'terminal.recruited', workspaceId: 'ws1', lastAt: now, leaving: false }]
        created++
      }
    }
    expect(created).toBe(3)
  })
})

describe('eventMeta', () => {
  it('maps known types to display metadata + metric buckets', () => {
    expect(eventMeta('terminal.recruited').metric).toBe('spawned')
    // Store emits `.forked` types (store.ts createdType / index.ts team fork)
    // — the META keys must match or forks fall through to the fallback.
    expect(eventMeta('terminal.forked').metric).toBe('forks')
    expect(eventMeta('team.forked').metric).toBe('forks')
    expect(eventMeta('workspace.switched').metric).toBe('switches')
    expect(eventMeta('terminal.recruited').hatch).toBe(true)
    expect(eventMeta('workspace.switched').hatch).toBe(false)
  })

  it('falls back gracefully for unknown types', () => {
    const meta = eventMeta('some.future.event')
    expect(meta.metric).toBeNull()
    expect(meta.icon).toBe('dot')
  })
})
