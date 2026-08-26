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

  it('is NULL when the workspace has terminals but no orch — never the first one', () => {
    // REVERSED on the owner's ruling (2026-08-26). This asserted the
    // first-terminal fallback, to keep the backend agreeing with a share sheet
    // that promised orch-else-first. The two did agree — on serving `QA Shell
    // Door`, a single orch-less zsh, which "answered" by RUNNING the caller's
    // text. The agreement now runs the other way: serve() refuses an orch-less
    // crew, so no workspace minted from a served template can reach this line
    // without an orch, and a null here means the orch died.
    expect(lookup.entryTerminalOf('ws-empty')).toBeNull()
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
