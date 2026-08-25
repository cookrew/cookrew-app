// PTYs learn which workspace they belong to.
//
// The map stays ONE map — terminal ids are globally unique, and sharding it
// would break allTerminalIdsStrict(), the orphan reaper's fail-safe, which has
// to see every terminal the app owns regardless of who is holding it. So a
// scope is a filtered VIEW, not a second registry.
//
// The measured reason this is a view and not N managers: the baseline probe
// (scratchpad/multi-instance-scaling-probe.mjs, 34 panes) put unbatched pane
// resolution at 44.8x batched, and flat-vs-linear in K. One inventory shared
// across all resident sessions is what keeps the batched line flat; N managers
// each doing their own discovery is precisely the O(attached x panes) shape
// that took /api/activity from 190ms to 6.85s in August.

import { describe, expect, it } from 'vitest'
import { PtyOwnership } from '../src/main/pty-scope'

describe('PtyOwnership', () => {
  it('is empty until something claims a terminal', () => {
    const own = new PtyOwnership()
    expect(own.workspaceOf('t1')).toBeUndefined()
    expect(own.idsFor('ws-a')).toEqual([])
  })

  it('tags a terminal with the workspace that booted it', () => {
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    expect(own.workspaceOf('t1')).toBe('ws-a')
    expect(own.idsFor('ws-a')).toEqual(['t1'])
  })

  it('groups terminals by workspace without losing the global view', () => {
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    own.claim('t2', 'ws-a')
    own.claim('t3', 'ws-b')

    expect(own.idsFor('ws-a').sort()).toEqual(['t1', 't2'])
    expect(own.idsFor('ws-b')).toEqual(['t3'])
    // The reaper's view: every terminal the app holds, whoever holds it.
    expect(own.all().sort()).toEqual(['t1', 't2', 't3'])
  })

  it('releases one terminal without disturbing its neighbours', () => {
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    own.claim('t2', 'ws-a')

    own.release('t1')
    expect(own.workspaceOf('t1')).toBeUndefined()
    expect(own.idsFor('ws-a')).toEqual(['t2'])
  })

  it('re-claiming moves a terminal rather than duplicating it', () => {
    // A terminal cut from one workspace and pasted into another keeps its id.
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    own.claim('t1', 'ws-b')

    expect(own.workspaceOf('t1')).toBe('ws-b')
    expect(own.idsFor('ws-a')).toEqual([])
    expect(own.idsFor('ws-b')).toEqual(['t1'])
    expect(own.all()).toEqual(['t1'])
  })

  it('drops a workspace entirely, reporting what it held', () => {
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    own.claim('t2', 'ws-a')
    own.claim('t3', 'ws-b')

    expect(own.releaseWorkspace('ws-a').sort()).toEqual(['t1', 't2'])
    expect(own.all()).toEqual(['t3'])
    expect(own.idsFor('ws-a')).toEqual([])
  })

  it('releasing an unknown workspace is a no-op, not a throw', () => {
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    expect(own.releaseWorkspace('nobody')).toEqual([])
    expect(own.all()).toEqual(['t1'])
  })

  it('never reports a terminal under two workspaces at once', () => {
    // The invariant that makes idsFor safe to detach from: a terminal has
    // exactly one holder, so no scope can tear down another scope's PTY.
    const own = new PtyOwnership()
    own.claim('t1', 'ws-a')
    own.claim('t1', 'ws-b')
    own.claim('t2', 'ws-a')

    const seen = [...own.idsFor('ws-a'), ...own.idsFor('ws-b')]
    expect(new Set(seen).size).toBe(seen.length)
  })
})
