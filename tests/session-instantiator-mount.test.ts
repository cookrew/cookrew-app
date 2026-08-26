import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  makeEntryTerminalLookup,
  rmSandbox,
  type WorkspaceNode
} from '../src/main/session-instantiator-mount'

/**
 * The two mount helpers that can be proven without the app: the scoped orch
 * lookup (never the focused canvas) and the rm -rf remover.
 */

describe('makeEntryTerminalLookup — the conductor is the workspace OWN orch', () => {
  const nodes: Record<string, WorkspaceNode[]> = {
    'ws-served': [
      { id: 't-worker', kind: 'terminal' },
      { id: 't-orch', kind: 'terminal', orch: true },
      { id: 'n-browser', kind: 'browser' }
    ],
    'ws-empty': [{ id: 't-plain', kind: 'terminal' }]
  }
  const lookup = makeEntryTerminalLookup({ nodesOf: (id) => nodes[id] ?? [] })

  it('finds the orch terminal in the addressed workspace', () => {
    expect(lookup.entryTerminalOf('ws-served')).toBe('t-orch')
  })

  it('answers with the FIRST terminal when no orch exists — the door the share sheet promised', () => {
    // SelectionBar's door line is orch-among-picked, else first terminal; a
    // lookup that refused an orch-less crew made the UI promise a door the
    // backend then 503'd. The two derivations must agree.
    expect(lookup.entryTerminalOf('ws-empty')).toBe('t-plain')
  })

  it('is null for a workspace it has no nodes for', () => {
    expect(lookup.entryTerminalOf('ws-gone')).toBeNull()
  })

  it('only ever reads the workspace it was asked about (never a focused canvas)', () => {
    const asked: string[] = []
    const scoped = makeEntryTerminalLookup({
      nodesOf: (id) => {
        asked.push(id)
        return nodes[id] ?? []
      }
    })
    scoped.entryTerminalOf('ws-served')
    expect(asked).toEqual(['ws-served'])
  })

  it('does not mistake a non-terminal orch-flagged node for the conductor', () => {
    const weird = makeEntryTerminalLookup({
      nodesOf: () => [{ id: 'b1', kind: 'browser', orch: true }]
    })
    expect(weird.entryTerminalOf('ws')).toBeNull()
  })
})

describe('rmSandbox — rm -rf semantics', () => {
  let base = ''
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'rm-sandbox-'))
  })
  afterEach(() => rmSandbox.remove(base))

  it('removes a populated directory tree', () => {
    const dir = path.join(base, 'svc', 'ana-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'work.txt'), 'x')
    expect(existsSync(dir)).toBe(true)
    rmSandbox.remove(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('does not throw on a directory that never existed', () => {
    expect(() => rmSandbox.remove(path.join(base, 'never', 'here'))).not.toThrow()
  })
})
