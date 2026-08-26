import { describe, expect, it } from 'vitest'
import { bootWorkspaceInPlace, planBootInPlace, type BootNode } from '../src/main/session-boot'

/**
 * BOOT-IN-PLACE selects a workspace's terminals and boots each — with no switch
 * and no detach, which is the whole point: a served session must not yank the
 * owner's screen.
 */

interface Node extends BootNode {
  id: string
  kind: string
}

const nodes: Record<string, Node[]> = {
  'ws-served': [
    { id: 't-orch', kind: 'terminal' },
    { id: 'n-browser', kind: 'browser' },
    { id: 't-worker', kind: 'terminal' }
  ],
  'ws-owner': [{ id: 't-owner', kind: 'terminal' }]
}

describe('planBootInPlace — only terminals boot', () => {
  it('keeps terminal nodes in order and drops the rest', () => {
    expect(planBootInPlace(nodes['ws-served']).map((n) => n.id)).toEqual(['t-orch', 't-worker'])
  })

  it('is empty for a workspace with no terminals', () => {
    expect(planBootInPlace([{ id: 'b', kind: 'browser' }])).toEqual([])
  })
})

describe('bootWorkspaceInPlace — boots the addressed workspace, nothing else', () => {
  it('boots each terminal of the addressed workspace once, in order', () => {
    const booted: string[] = []
    const n = bootWorkspaceInPlace(
      { nodesOf: (id) => nodes[id] ?? [], boot: (node) => booted.push(node.id) },
      'ws-served'
    )
    expect(n).toBe(2)
    expect(booted).toEqual(['t-orch', 't-worker'])
  })

  it('reads ONLY the addressed workspace — never the owner canvas', () => {
    const asked: string[] = []
    bootWorkspaceInPlace(
      {
        nodesOf: (id) => {
          asked.push(id)
          return nodes[id] ?? []
        },
        boot: () => undefined
      },
      'ws-served'
    )
    // The owner's workspace is never touched — no switch, no detach, no read.
    expect(asked).toEqual(['ws-served'])
  })

  it('one bad node does not strand its siblings — the loop isolates each boot', () => {
    const booted: string[] = []
    const failed: string[] = []
    const n = bootWorkspaceInPlace(
      {
        nodesOf: (id) => nodes[id] ?? [],
        boot: (node) => {
          if (node.id === 't-orch') throw new Error('orch boot failed')
          booted.push(node.id)
        },
        onError: (node) => failed.push(node.id)
      },
      'ws-served'
    )
    // The worker still booted; the failure was reported, not thrown; the count
    // is successes, so a caller can tell this was a partial boot.
    expect(booted).toEqual(['t-worker'])
    expect(failed).toEqual(['t-orch'])
    expect(n).toBe(1)
  })

  it('boots nothing for a workspace it has no nodes for', () => {
    const booted: string[] = []
    const n = bootWorkspaceInPlace(
      { nodesOf: (): Node[] => [], boot: (node) => booted.push(node.id) },
      'ws-gone'
    )
    expect(n).toBe(0)
    expect(booted).toEqual([])
  })
})
