// A RECRUITED CARD'S SENTENCE IS ITS BRIEF, AND A RESPAWN TYPES NOTHING (route
// program R3, live finding after the RTE respawn: the sentence came back in the
// composer unsent while the ledger held one done dispatch).
//
// Two halves. The pure one: what the recruit writes, and what the one
// spawn-time typing path is allowed to say. The wiring one, as a source proxy
// (house pattern, tests/rail-focus-render.test.ts): index.ts writes the
// recruit patch, routes its only spawn-time injection through the helper, and
// keys role boot on a SAVED role resolved at creation — never on the node's
// text on a respawn.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recruitPatch, spawnInjectionFor } from '../src/main/recruit-node'

const SENTENCE = 'write a haiku about cables'

describe('recruitPatch — the sentence lands as the brief, and the role stays empty', () => {
  it('writes brief = the sentence and role = null', () => {
    expect(recruitPatch(SENTENCE)).toEqual({ brief: SENTENCE, role: null })
  })
})

describe('spawnInjectionFor — what a spawn or respawn may type', () => {
  it('a recruited card types nothing on a respawn', () => {
    expect(spawnInjectionFor({ ...recruitPatch(SENTENCE), pendingInject: null })).toBeNull()
    expect(spawnInjectionFor({ ...recruitPatch(SENTENCE) })).toBeNull()
  })

  it('a card from before the fix, with the sentence still in role, types nothing either', () => {
    expect(spawnInjectionFor({ role: SENTENCE, brief: null, pendingInject: null })).toBeNull()
  })

  it('a saved role name is never typed by a spawn — role boot is a creation-time act', () => {
    expect(spawnInjectionFor({ role: 'Developer', brief: null })).toBeNull()
  })

  it('only a staged copy preamble is typed, and an empty stage is nothing', () => {
    expect(spawnInjectionFor({ role: null, brief: SENTENCE, pendingInject: 'You are a copy of Forge…' })).toBe('You are a copy of Forge…')
    expect(spawnInjectionFor({ role: null, brief: null, pendingInject: '' })).toBeNull()
  })
})

describe('index.ts wiring — the recruit, the one injection path, and role boot', () => {
  const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8').replace(/\s+/g, ' ')

  it('the recruit dep writes the recruit patch, not a role', () => {
    // the brief is scrubbed on its way onto the node (Tinker's scrub), still through the recruit patch
    expect(main).toMatch(/updateNode\(node\.id, recruitPatch\((?:scrub\()?brief\)?\)\)/)
    expect(main).not.toContain('updateNode(node.id, { role })')
  })

  it('the deferred injection reads the node through spawnInjectionFor', () => {
    expect(main).toContain('const inject = spawnInjectionFor(t)')
    expect(main).not.toContain('const inject = t.pendingInject')
  })

  it('role boot is keyed on a SAVED role resolved from opts.roleName at creation, never on node text', () => {
    expect(main).toContain('const role = opts.roleName ? roles.get(opts.roleName) : undefined')
    // The role's boot message leads; a first prompt from the global prompt box follows it, one injection.
    expect(main).toContain("const boot = [role ? buildRoleBootMessage(role.name, role.rolePrompt) : '', first]")
    expect(main).toContain('injectWhenReady(session, boot)')
    // the respawn is a kill + spawnTracked, with no injection of its own
    expect(main).toMatch(/respawn: async \(id\) => \{[^}]*spawnTracked\(node\)[^}]*\}/)
    expect(main).not.toMatch(/respawn: async \(id\) => \{[^}]*inject[^}]*\}/)
  })
})
