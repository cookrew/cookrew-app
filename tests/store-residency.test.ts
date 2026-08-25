// The store stops hydrating exactly one workspace.
//
// Until now WorkspaceStore held a single `state` — the ACTIVE workspace's
// canvas — and every other workspace existed only as JSON on disk. That is the
// singleton marketplace-architecture §11 is written against: one focus change
// swapped the world out from under every seat, and orchestration in the
// workspace you looked away from was severed.
//
// Now the store holds a MAP of hydrated sessions, and focus is just a label
// saying which one a seat is looking at. Residency is the authority; focus is
// a hint. What is pinned here is that the two are no longer the same thing —
// and, under COOKREW_MULTI_INSTANCE=0, that the old behaviour is preserved
// exactly, because a flag-off regression is the one thing this refactor is not
// allowed to cost.

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import type { NoteNodeData, TerminalNodeData, WorkspaceState } from '../src/shared/model'

function terminal(name: string, cwd = '/work/alpha'): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `id-${name.toLowerCase().replace(/\s+/g, '-')}-${Math.floor(Math.random() * 1e9)}`,
    name,
    preset: 'Claude Code',
    command: 'claude',
    cwd,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  }
}

function makeStore(multi: boolean): WorkspaceStore {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-residency-'))
  return new WorkspaceStore(base, { multiInstance: multi })
}

/** Read a workspace's canvas straight off disk, bypassing the store. */
function onDisk(store: WorkspaceStore, id: string): WorkspaceState {
  const file = path.join(store.baseDirForTests, 'workspaces', id, 'workspace.json')
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceState
}

afterEach(() => vi.useRealTimers())

describe('focus stops wearing the singleton name', () => {
  it('no longer exposes activeId — the name that conflated live and looked-at', () => {
    const store = makeStore(false)
    const surface = store as unknown as Record<string, unknown>
    expect(surface.activeId).toBeUndefined()
    expect(store.focusedId).toBeTruthy()
  })

  it('focusedState and focusedMeta agree with each other', () => {
    const store = makeStore(true)
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)

    expect(store.focusedMeta()?.id).toBe(beta.id)
    expect(store.focusedMeta()?.name).toBe('Beta')
    expect(store.focusedState.name).toBe('Beta')
    expect(store.focusedState).toBe(store.workspaceState(beta.id))
  })

  it('list() still reports focus on the wire under its old key', () => {
    // WorkspaceList.activeId is the renderer/phone contract; renaming it is
    // step 2's job, together with scoping it to the asking seat.
    const store = makeStore(false)
    expect(store.list().activeId).toBe(store.focusedId)
  })
})

describe('residency vs focus', () => {
  it('flag OFF keeps exactly one workspace hydrated — today, unchanged', () => {
    const store = makeStore(false)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')

    expect(store.resident()).toEqual([alpha])
    store.switchWorkspace(beta.id)
    expect(store.resident()).toEqual([beta.id])
    expect(store.focusedId).toBe(beta.id)
  })

  it('flag ON keeps the workspace you left hydrated', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')

    store.switchWorkspace(beta.id)
    expect(store.resident().sort()).toEqual([alpha, beta.id].sort())
    expect(store.focusedId).toBe(beta.id)
  })

  it("still emits 'switch' with the outgoing terminals, both flag states", () => {
    // index.ts detaches PTYs inside this listener. Commit 1 must not change
    // what it hears; the listener itself changes in commit 2.
    for (const multi of [false, true]) {
      const store = makeStore(multi)
      const outgoing = store.addNode(terminal('Coder')) as TerminalNodeData
      const beta = store.createWorkspace('Beta', '/work/beta')
      const heard: string[][] = []
      store.on('switch', ({ previousTerminalIds }) => heard.push(previousTerminalIds))

      store.switchWorkspace(beta.id)
      expect(heard).toEqual([[outgoing.id]])
    }
  })
})

describe('a hydrated background workspace is a real canvas', () => {
  it('edits it in MEMORY, not through a disk round-trip', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id) // alpha stays resident, unfocused

    const node = store.addNodeToWorkspace(alpha, terminal('Background'))
    // Resident means the store can see it without loading the file.
    expect(store.workspaceState(alpha).nodes.map((n) => n.id)).toContain(node.id)
    expect(store.terminalIdsOf(alpha)).toContain(node.id)
  })

  it('persists a background edit to ITS OWN partition', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)

    const node = store.addNodeToWorkspace(alpha, terminal('Background'))
    store.flush()

    expect(onDisk(store, alpha).nodes.map((n) => n.id)).toContain(node.id)
    expect(onDisk(store, beta.id).nodes.map((n) => n.id)).not.toContain(node.id)
  })

  it('attributes the event to the workspace that did the work', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)

    const seen: { type: string; workspaceId: string }[] = []
    store.on('op', (e) => seen.push({ type: e.type, workspaceId: e.workspaceId }))
    store.addNodeToWorkspace(alpha, terminal('Background'))

    expect(seen).toHaveLength(1)
    expect(seen[0].workspaceId).toBe(alpha) // NOT the focused one
  })

  it('writes a background note file under its own notes dir', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)

    const note = store.addNodeToWorkspace(alpha, {
      kind: 'note',
      id: 'note-bg',
      name: 'Background note',
      content: 'written while unfocused',
      locked: false,
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 }
    } as NoteNodeData)

    // The mirror is best-effort async; the id/partition mapping is what matters.
    expect(store.notesDirOf(alpha)).toBe(
      path.join(store.baseDirForTests, 'workspaces', alpha, 'notes')
    )
    expect(store.notesDirOf(alpha)).not.toBe(store.notesDirOf(beta.id))
    expect(note.name).toBe('Background note')
  })
})

describe('the debounced save resolves its target at SCHEDULE time (R5)', () => {
  it('a save scheduled before a focus change lands in the right partition', () => {
    // The old code computed the save target from activeId when the 300ms timer
    // FIRED, and stayed correct only because switchWorkspace flushed first.
    // With N sessions that ordering guarantee is gone, so the timer now
    // carries its own workspace.
    vi.useFakeTimers()
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')

    const node = store.addNode(terminal('Alpha work')) as TerminalNodeData // schedules a save for alpha
    store.switchWorkspace(beta.id) // focus moves before the timer fires
    vi.advanceTimersByTime(1000)

    expect(onDisk(store, alpha).nodes.map((n) => n.id)).toContain(node.id)
    expect(onDisk(store, beta.id).nodes.map((n) => n.id)).not.toContain(node.id)
  })

  it('flushes every resident session, not just the focused one', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)

    const bg = store.addNodeToWorkspace(alpha, terminal('Background'))
    const fg = store.addNode(terminal('Foreground')) as TerminalNodeData
    store.flush() // app quit

    expect(onDisk(store, alpha).nodes.map((n) => n.id)).toContain(bg.id)
    expect(onDisk(store, beta.id).nodes.map((n) => n.id)).toContain(fg.id)
  })
})

describe('eviction', () => {
  it('flushes a session on the way out — an evicted edit is not a lost edit', () => {
    const store = makeStore(false) // flag off: switching evicts
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')

    const node = store.addNode(terminal('Alpha work')) as TerminalNodeData
    store.switchWorkspace(beta.id) // evicts alpha

    expect(store.resident()).toEqual([beta.id])
    expect(onDisk(store, alpha).nodes.map((n) => n.id)).toContain(node.id)
  })

  it('a workspace deleted while resident leaves nothing behind', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)
    expect(store.resident()).toContain(alpha)

    store.removeWorkspace(alpha)
    expect(store.resident()).not.toContain(alpha)
    expect(existsSync(path.join(store.baseDirForTests, 'workspaces', alpha))).toBe(false)
  })
})

describe('the registry stops being the authority on focus', () => {
  it('persists focus as a boot HINT and survives its absence', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-residency-'))
    const first = new WorkspaceStore(base, { multiInstance: false })
    const beta = first.createWorkspace('Beta', '/work/beta')
    first.switchWorkspace(beta.id)
    first.flush()

    const reopened = new WorkspaceStore(base, { multiInstance: false })
    expect(reopened.focusedId).toBe(beta.id)
  })

  it('falls back to the first workspace when the hint names a stranger', () => {
    // A registry written by another window, or hand-edited, must not leave the
    // store focused on a workspace that does not exist.
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-residency-'))
    const first = new WorkspaceStore(base, { multiInstance: false })
    const alpha = first.focusedId
    first.flush()

    const registryFile = path.join(base, 'registry.json')
    const raw = JSON.parse(readFileSync(registryFile, 'utf8'))
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(registryFile, JSON.stringify({ ...raw, activeId: 'nope' }), 'utf8')

    const reopened = new WorkspaceStore(base, { multiInstance: false })
    expect(reopened.focusedId).toBe(alpha)
    expect(reopened.focusedState.nodes).toEqual([])
  })
})

describe('slugs — every workspace is addressable (step 3)', () => {
  it('mints a frozen slug at creation and resolves it back', () => {
    const store = makeStore(false)
    const beta = store.createWorkspace('My Playground', '/work/beta')

    expect(store.slugOf(beta.id)).toBe('my-playground')
    expect(store.bySlug('my-playground')?.id).toBe(beta.id)
  })

  it('a rename does NOT move the address', () => {
    // The freeze rule: a phone bookmarked this URL and an exported agent is
    // called at it. The label changes; the address does not.
    const store = makeStore(false)
    const beta = store.createWorkspace('My Playground', '/work/beta')
    store.renameWorkspace(beta.id, 'Something Else Entirely')

    expect(store.slugOf(beta.id)).toBe('my-playground')
    expect(store.bySlug('my-playground')?.name).toBe('Something Else Entirely')
  })

  it('collides with a -2 suffix rather than stealing an address', () => {
    const store = makeStore(false)
    const first = store.createWorkspace('Playground', '/work/a')
    const second = store.createWorkspace('Playground', '/work/b')

    expect(store.slugOf(first.id)).toBe('playground')
    expect(store.slugOf(second.id)).toBe('playground-2')
    expect(store.bySlug('playground')?.id).toBe(first.id)
  })

  it('backfills a pre-step-3 registry and PERSISTS it', () => {
    // A slug that lived only in memory would be re-minted every boot, which is
    // the moving address the freeze exists to prevent.
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-residency-'))
    const first = new WorkspaceStore(base, { multiInstance: false })
    const beta = first.createWorkspace('Beta', '/work/beta')
    first.flush()

    // Strip every slug, as a registry written before step 3 would look.
    const registryFile = path.join(base, 'registry.json')
    const raw = JSON.parse(readFileSync(registryFile, 'utf8'))
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(
      registryFile,
      JSON.stringify({
        ...raw,
        workspaces: raw.workspaces.map((w: Record<string, unknown>) => {
          const { slug, ...rest } = w
          return rest
        })
      }),
      'utf8'
    )

    const reopened = new WorkspaceStore(base, { multiInstance: false })
    const backfilled = reopened.slugOf(beta.id)
    expect(backfilled).toBe('beta')

    // Same answer after another boot — proving it went to disk.
    const again = new WorkspaceStore(base, { multiInstance: false })
    expect(again.slugOf(beta.id)).toBe(backfilled)
  })

  it('an unknown slug resolves to nothing, never to the focused workspace', () => {
    const store = makeStore(false)
    expect(store.bySlug('no-such-workspace')).toBeUndefined()
  })
})

describe('durability and teardown (review M2, C3)', () => {
  it('flushes the workspace being left BEFORE recording the new focus', () => {
    // Crash-window ordering: the registry write must not land first, or the
    // app reopens on the new workspace having lost up to 300ms of the old
    // one's edits. The edits are the user's work; the focus hint is a
    // convenience.
    vi.useFakeTimers()
    const store = makeStore(false)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')

    const node = store.addNode(terminal('Unsaved')) as TerminalNodeData
    store.switchWorkspace(beta.id) // no timer advance: only the flush can save it

    expect(onDisk(store, alpha).nodes.map((n) => n.id)).toContain(node.id)
    const registry = JSON.parse(
      readFileSync(path.join(store.baseDirForTests, 'registry.json'), 'utf8')
    )
    expect(registry.activeId).toBe(beta.id)
  })

  it('releaseSession drops a background session and flushes it', () => {
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)
    const node = store.addNodeToWorkspace(alpha, terminal('Background'))

    expect(store.releaseSession(alpha)).toBe(true)
    expect(store.resident()).toEqual([beta.id])
    expect(onDisk(store, alpha).nodes.map((n) => n.id)).toContain(node.id)
  })

  it('REFUSES to release the focused session', () => {
    // Focus is one of the liveness facts, so being asked to drop it means the
    // caller's facts are wrong — and dropping it would leave no canvas.
    const store = makeStore(true)
    expect(store.releaseSession(store.focusedId)).toBe(false)
    expect(store.resident()).toContain(store.focusedId)
  })
})

describe('a background node patch is not dropped (review H2)', () => {
  it('updateNodeUnsafe falls through to the owning workspace', () => {
    // Async harness binds are keyed by terminal id and land whenever a probe
    // resolves — with sessions resident, long after focus moved on. Matching
    // only the focused canvas would drop a session rebind silently, which is
    // the exact-context failure shape.
    const store = makeStore(true)
    const alpha = store.focusedId
    const beta = store.createWorkspace('Beta', '/work/beta')
    const bg = store.addNodeToWorkspace(alpha, terminal('Background')) as TerminalNodeData
    store.switchWorkspace(beta.id)

    const patched = store.updateNodeUnsafe(bg.id, { claudeSessionId: 'sess-abc' })

    expect(patched).toBeDefined()
    expect((patched as TerminalNodeData).claudeSessionId).toBe('sess-abc')
    const persisted = store.workspaceState(alpha).nodes.find((n) => n.id === bg.id)
    expect((persisted as TerminalNodeData).claudeSessionId).toBe('sess-abc')
  })
})
