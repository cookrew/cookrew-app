// THE CALLER OF A SECRET VERB: a live owner pane of this app, resolved from
// a real COOKREW_TERMINAL_ID — never `--as`, never the agent registry, never
// a pane spawned for a served session.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ownerPaneOf, type SocketServerDeps } from '../src/main/socket-server'
import { SecretCliError, SECRET_EXIT } from '../src/main/secret-cli'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'

const pane = (id: string, over: Partial<TerminalNodeData> = {}): TerminalNodeData =>
  ({ kind: 'terminal', id, name: id, preset: 'claude', command: 'claude', cwd: '/', orch: false, role: null, ...over }) as TerminalNodeData

const deps = (over: {
  node?: (id: string) => TerminalNodeData | undefined
  across?: (id: string) => { node: TerminalNodeData; workspaceId: string } | undefined
  registry?: (id: string) => unknown
  isServed?: (id: string) => boolean
}): SocketServerDeps =>
  ({
    store: {
      node: over.node ?? (() => undefined),
      nodeAcrossWorkspaces: over.across ?? (() => undefined),
      terminalsAcross: () => []
    },
    agents: { lookup: over.registry ?? (() => undefined), list: () => [] },
    isServed: over.isServed ?? (() => false)
  }) as unknown as SocketServerDeps

const request = (over: Partial<CliRequest>): CliRequest =>
  ({ id: 'r', cmd: 'secret', args: ['read', 'stripe-key'], flags: {}, terminalId: 't-owner', ...over }) as CliRequest

const refusal = (fn: () => unknown): SecretCliError => {
  try {
    fn()
  } catch (error) {
    if (error instanceof SecretCliError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('ownerPaneOf', () => {
  it('answers a live owner pane the store knows, on this canvas or another', () => {
    expect(ownerPaneOf(request({}), deps({ node: (id) => (id === 't-owner' ? pane('t-owner') : undefined) })).id).toBe('t-owner')
    expect(
      ownerPaneOf(request({}), deps({ across: (id) => (id === 't-owner' ? { node: pane('t-owner'), workspaceId: 'w2' } : undefined) })).id
    ).toBe('t-owner')
  })

  it('refuses a pane spawned served — by the REAL fact, whatever the node says', () => {
    const served = pane('t-seat')
    const error = refusal(() =>
      ownerPaneOf(request({ terminalId: 't-seat' }), deps({ node: () => served, isServed: (id) => id === 't-seat' }))
    )
    expect(error.exitCode).toBe(SECRET_EXIT.refused)
    expect(error.message).toContain('served session')
    // And the owner's own pane is not confused with it when the predicate says no.
    expect(ownerPaneOf(request({}), deps({ node: () => pane('t-owner'), isServed: () => false })).id).toBe('t-owner')
  })

  it('refuses `--as`, with or without a terminal id', () => {
    const d = deps({ node: () => pane('t-owner') })
    expect(refusal(() => ownerPaneOf(request({ flags: { as: 'Orch' }, terminalId: '' }), d)).message).toContain('--as')
    expect(refusal(() => ownerPaneOf(request({ flags: { as: 'Orch' } }), d)).exitCode).toBe(SECRET_EXIT.refused)
  })

  it('refuses a shell with no terminal id', () => {
    expect(refusal(() => ownerPaneOf(request({ terminalId: '' }), deps({}))).message).toContain('not a Cookrew terminal')
  })

  it('refuses the registry fallback: a terminal the store has forgotten is not a live pane', () => {
    const error = refusal(() =>
      ownerPaneOf(request({ terminalId: 't-ghost' }), deps({ registry: () => ({ terminalId: 't-ghost', name: 'Ghost' }) }))
    )
    expect(error.exitCode).toBe(SECRET_EXIT.refused)
    expect(error.message).toContain('no live pane')
  })
})

describe('the served predicate is required', () => {
  it('is not optional on the deps, and the verb reads it without a fail-open', () => {
    const src = readFileSync('src/main/socket-server.ts', 'utf8')
    expect(src).toContain('isServed: (terminalId: string) => boolean')
    expect(src).not.toContain('isServed?.(')
    expect(src).toContain("if (deps.isServed(id)) throw refuse('never readable from a served session')")
  })
})
