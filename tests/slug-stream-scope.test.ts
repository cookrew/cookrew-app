// The §11 outcome, asserted: a phone on /playground ignores desktop focus.
//
// This is the bug the whole workstream exists to close. One active workspace
// served ALL seats, so switching focus on the desktop flipped every phone's
// view with it. The channel that did the flipping is /api/events: it pushed
// store's focused 'change' to every subscriber regardless of which workspace
// that subscriber had asked for.
//
// Pinned here at the store's signal layer, where the behaviour actually lives.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import type { TerminalNodeData, WorkspaceState } from '../src/shared/model'

function terminal(name: string): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `id-${name}-${Math.floor(Math.random() * 1e9)}`,
    name,
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  }
}

function twoWorkspaces(): {
  store: WorkspaceStore
  dev: string
  play: string
} {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-slug-')), {
    multiInstance: true
  })
  const dev = store.focusedId
  const play = store.createWorkspace('Playground', '/work/play').id
  return { store, dev, play }
}

/** What a phone scoped to `workspaceId` would receive on its SSE stream. */
function scopedSubscriber(store: WorkspaceStore, workspaceId: string): WorkspaceState[] {
  const received: WorkspaceState[] = []
  store.on('workspace-change', (payload: { workspaceId: string; state: WorkspaceState }) => {
    if (payload.workspaceId === workspaceId) received.push(payload.state)
  })
  return received
}

/** What an UNSLUGGED phone receives — the old behaviour, unchanged. */
function focusedSubscriber(store: WorkspaceStore): WorkspaceState[] {
  const received: WorkspaceState[] = []
  store.on('change', (state: WorkspaceState) => received.push(state))
  return received
}

describe('a scoped phone ignores desktop focus (§11)', () => {
  it('receives NOTHING when the desktop merely switches workspace', () => {
    // The bug, in one assertion. Switching focus is not a change to the
    // playground canvas, so a phone reading /playground must not be told
    // anything — least of all handed the other workspace's state.
    const { store, dev, play } = twoWorkspaces()
    const phone = scopedSubscriber(store, play)

    store.switchWorkspace(play)
    store.switchWorkspace(dev)

    expect(phone).toEqual([])
  })

  it('receives its OWN workspace edits while that workspace is unfocused', () => {
    // The other half, and the one that makes the first half honest: silence
    // must mean "nothing happened here", not "this stream is dead".
    const { store, dev, play } = twoWorkspaces()
    expect(store.focusedId).toBe(dev)
    const phone = scopedSubscriber(store, play)

    const node = store.addNodeToWorkspace(play, terminal('Coder'))

    expect(phone).toHaveLength(1)
    expect(phone[0].nodes.map((n) => n.id)).toContain(node.id)
  })

  it('is not disturbed by edits to the OTHER workspace', () => {
    const { store, dev, play } = twoWorkspaces()
    const phone = scopedSubscriber(store, play)

    store.addNode(terminal('Focused work')) // lands in dev, the focused one

    expect(phone).toEqual([])
  })

  it('two phones on two slugs each see only their own', () => {
    const { store, dev, play } = twoWorkspaces()
    const devPhone = scopedSubscriber(store, dev)
    const playPhone = scopedSubscriber(store, play)

    store.addNodeToWorkspace(play, terminal('In play'))
    store.addNodeToWorkspace(dev, terminal('In dev'))

    expect(playPhone).toHaveLength(1)
    expect(devPhone).toHaveLength(1)
    expect(playPhone[0].nodes.some((n) => n.name === 'In play')).toBe(true)
    expect(devPhone[0].nodes.some((n) => n.name === 'In dev')).toBe(true)
  })
})

describe('the unslugged stream is untouched', () => {
  it("still means 'the canvas on screen changed'", () => {
    // Every paired phone holds a bookmark to /. Widening 'change' to carry
    // background workspaces would have pushed other canvases at all of them.
    const { store, play } = twoWorkspaces()
    const legacy = focusedSubscriber(store)

    store.addNode(terminal('Focused work')) // focused: delivered
    store.addNodeToWorkspace(play, terminal('Background')) // background: not

    expect(legacy).toHaveLength(1)
    expect(legacy[0].nodes.some((n) => n.name === 'Focused work')).toBe(true)
  })
})
