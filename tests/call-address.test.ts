import { describe, expect, it } from 'vitest'
import { parseCallAddress, parseCeremonyRoute, resolveAgentByName } from '../src/main/call-route'
import { nodeIdOfRoute, scopedRouteSupported, NODE_ROUTES } from '../src/main/mobile-slug-route'
import type { CanvasNode } from '../src/shared/model'

/**
 * THE ADDRESS (④ · S2) — /<slug>/agents/<name>/ask.
 *
 * Parsing and resolution, and the two table properties the route rests on: it
 * IS allow-listed under a slug, and it is NOT node-addressed, so the membership
 * choke point must decline to extract an id from it.
 */

const terminal = (id: string, name: string): CanvasNode =>
  ({ kind: 'terminal', id, name, preset: 'claude', command: 'claude', cwd: '/tmp',
     orch: false, role: null }) as CanvasNode

const note = (id: string, name: string): CanvasNode =>
  ({ kind: 'note', id, name, text: '' }) as unknown as CanvasNode

describe('parseCallAddress', () => {
  it('parses the call address', () => {
    expect(parseCallAddress('POST', '/agents/forge/ask')).toEqual({ agent: 'forge' })
  })

  it('percent-decodes a name that needed escaping', () => {
    expect(parseCallAddress('POST', '/agents/echo%20bench/ask')).toEqual({ agent: 'echo bench' })
  })

  it('refuses a malformed escape rather than passing the literal bytes', () => {
    // Two spellings that both "work" would be two addresses for one resource.
    expect(parseCallAddress('POST', '/agents/%E0%A4%A/ask')).toBeNull()
  })

  it('is POST only — a GET here is not a call', () => {
    // A callable route reachable by a link is a route a browser preloads.
    expect(parseCallAddress('GET', '/agents/forge/ask')).toBeNull()
    expect(parseCallAddress('HEAD', '/agents/forge/ask')).toBeNull()
  })

  it('does not match a deeper or shallower path', () => {
    expect(parseCallAddress('POST', '/agents/forge/ask/extra')).toBeNull()
    expect(parseCallAddress('POST', '/agents/forge')).toBeNull()
    expect(parseCallAddress('POST', '/agents//ask')).toBeNull()
    expect(parseCallAddress('POST', '/api/agents/forge/ask')).toBeNull()
  })

  it('cannot be walked out of with a traversal segment', () => {
    // `[^/]+` means a name is one segment; the slug split has already happened.
    expect(parseCallAddress('POST', '/agents/../api/state/ask')).toBeNull()
  })
})

describe('parseCeremonyRoute', () => {
  it('knows its two routes, POST only', () => {
    expect(parseCeremonyRoute('POST', '/api/call/challenge')).toBe('challenge')
    expect(parseCeremonyRoute('POST', '/api/call/assert')).toBe('assert')
    expect(parseCeremonyRoute('GET', '/api/call/challenge')).toBeNull()
    expect(parseCeremonyRoute('POST', '/api/call/other')).toBeNull()
  })
})

describe('resolveAgentByName — scoped by resolution, not by membership', () => {
  const nodes = [terminal('n1', 'Forge'), terminal('n2', 'Atlas'), note('n3', 'Scratch')]

  it('resolves a terminal by name, case-insensitively', () => {
    expect(resolveAgentByName(nodes, 'forge')).toEqual({ kind: 'found', nodeId: 'n1', name: 'Forge' })
    expect(resolveAgentByName(nodes, 'FORGE')).toEqual({ kind: 'found', nodeId: 'n1', name: 'Forge' })
  })

  it('does not resolve a note or a browser — a card is not a teammate', () => {
    expect(resolveAgentByName(nodes, 'Scratch')).toEqual({ kind: 'none' })
  })

  it('refuses an ambiguity instead of picking the first', () => {
    // Picking by order would make the address depend on canvas layout: calling
    // "forge" could reach a different agent after the owner moved a card.
    const two = [terminal('n1', 'Forge'), terminal('n2', 'forge')]
    expect(resolveAgentByName(two, 'forge')).toEqual({ kind: 'ambiguous' })
  })

  it('finds nothing in an empty workspace', () => {
    expect(resolveAgentByName([], 'forge')).toEqual({ kind: 'none' })
  })

  it('only ever sees the nodes it was handed — there is no global lookup', () => {
    // The scope property, as a property: an agent that exists in ANOTHER
    // workspace is simply not among these nodes, so it cannot be addressed.
    const otherWorkspace = [terminal('n9', 'Tinker')]
    expect(resolveAgentByName(nodes, 'Tinker')).toEqual({ kind: 'none' })
    expect(resolveAgentByName(otherWorkspace, 'Tinker').kind).toBe('found')
  })
})

describe('the route tables agree about what this route is', () => {
  it('is allow-listed under a slug, so it is not refused 501', () => {
    expect(scopedRouteSupported('/agents/forge/ask')).toBe(true)
    expect(scopedRouteSupported('/api/call/challenge')).toBe(true)
    expect(scopedRouteSupported('/api/call/assert')).toBe(true)
  })

  it('is NOT node-addressed, so the membership extractor declines it', () => {
    // The two scoping mechanisms are different. If nodeIdOfRoute ever returned
    // something here, "forge" would be checked as a node id against ownerOf and
    // the real resolution would be bypassed.
    expect(nodeIdOfRoute('/agents/forge/ask')).toBeNull()
    expect(nodeIdOfRoute('/api/call/assert')).toBeNull()
  })

  it('is absent from NODE_ROUTES, which is what makes the above stable', () => {
    expect(NODE_ROUTES.some((pattern) => pattern.test('/agents/forge/ask'))).toBe(false)
  })
})
