// THE WIRE CARRIES THE CEREMONY AND THE CALL, NEVER THE GRANT.
//
// The grant surface is strictly MORE powerful than the gate it feeds: anyone
// who can reach it enrols themselves and exports every agent in the workspace,
// which makes every refusal downstream decorative. So the rule is not "we do
// not currently mount it" — it is that mounting it must FAIL THE BUILD.
//
// WHAT THIS SWEEP USED TO BE, AND WHY IT WAS NOT ENOUGH (Magpie, R-G4/R-G5).
//
// It listed the grant operations by name — enrol, revoke, exportAgent,
// unexport — and refused those names in the listener sources. Magpie showed
// that passing while enrolment was genuinely mounted: rename the operation,
// call it from mobile-api.ts, and the sweep sees nothing. The hole is not a
// weak pattern, and no better pattern closes it, because THE THING BEING
// RENAMED IS THE THING BEING SEARCHED FOR. The list and the code drift apart
// in silence and the sweep reports the drift as proof.
//
// The channel half had the same hole one layer along. It listed the literal
// channel names, and a bridge that computes `grant:${op}` never spells one.
//
// So neither half searches for a name any more:
//
//   REACH, NOT NAMES. Every static value import is walked TRANSITIVELY from the
//   listener roots, and any path that arrives at a grant-mutating MODULE fails.
//   Transitive because a helper in between defeats a one-hop rule, and a helper
//   in between is the likelier accident. A rename cannot move a module's path.
//
//   THE PRIMITIVE, NOT THE CHANNEL. No listener-reachable module may touch
//   ipcMain or ipcRenderer at all, and the electron bindings it may import are
//   a CLOSED allow-list. A computed channel name still needs the primitive.
//
// The residual is stated rather than hidden: a dynamic import with a computed
// specifier is not statically resolvable, so the walk cannot say where it goes.
// Such an edge is reported BLOCK, not passed over — treating an edge nobody can
// follow as absent would be the same mistake the name list made.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeSourcePort, virtualSourcePort } from './support/module-imports'
import { reachFrom, sweepGrantReach, type Violation } from './support/listener-reach'

const ROOT = path.join(__dirname, '..')
const MAIN = path.join(ROOT, 'src', 'main')

/**
 * Modules that answer requests arriving from OUTSIDE this process — the mobile
 * listener, its API layer, the route splitter, and the registry service. These
 * are the roots; everything they can reach is in scope.
 */
const LISTENER_ROOTS = [
  path.join(MAIN, 'mobile-server.ts'),
  path.join(MAIN, 'mobile-api.ts'),
  path.join(MAIN, 'mobile-slug-route.ts'),
  path.join(MAIN, 'mobile-endpoints.ts'),
  path.join(MAIN, 'mobile-http.ts'),
  path.join(MAIN, 'socket-server.ts'),
  path.join(ROOT, 'registry', 'src')
]

/**
 * The modules that hold operations deciding who reaches the internet.
 *
 * owner-grant.ts is the owner's surface. agent-export.ts is the store beneath
 * it — a module that value-imports the store class can construct one over the
 * same file on disk, which is the same power by a longer road. The gate reads
 * grants through narrow functions handed to it, and `import type { AgentExport }`
 * is erased before it runs, so neither of those is reach and neither fires.
 */
const GRANT_MODULES = [path.join(MAIN, 'owner-grant.ts'), path.join(MAIN, 'agent-export.ts')]

/**
 * What a listener-reachable module may import from electron.
 *
 * Closed, and vouched for one at a time. `powerSaveBlocker` keeps the machine
 * awake while a call is in flight and decides nothing.
 */
const ELECTRON_ALLOWED = ['powerSaveBlocker']

function sweepTree(): Violation[] {
  return sweepGrantReach(
    {
      roots: LISTENER_ROOTS,
      forbidden: GRANT_MODULES,
      electronAllowed: ELECTRON_ALLOWED,
      relativeTo: ROOT
    },
    nodeSourcePort()
  )
}

describe('no listener reaches the grant surface', () => {
  it('no path from any listener root arrives at a grant mutator', () => {
    expect(sweepTree().map((v) => v.detail)).toEqual([])
  })

  it('covers the listener roots it claims to cover, and a real graph', () => {
    // A sweep pointed at files that do not exist passes vacuously, which reads
    // as proof and is not.
    const port = nodeSourcePort()
    for (const root of LISTENER_ROOTS) {
      expect(port.exists(root), `missing listener root: ${root}`).toBe(true)
    }
    for (const grant of GRANT_MODULES) {
      expect(port.exists(grant), `missing grant module: ${grant}`).toBe(true)
    }
    // And a walk that found only the roots themselves would be a one-hop rule
    // wearing a transitive coat.
    const { reached } = reachFrom(LISTENER_ROOTS, port)
    expect(reached.size).toBeGreaterThan(LISTENER_ROOTS.length * 2)
  })
})

// ---------------------------------------------------------------------------
// THE MUTANTS. A conformance test that cannot be shown to fail is decoration —
// the standard the /api sweep had to meet after it was found blind to
// streamUrl, and the standard this sweep failed until Magpie applied it.
// ---------------------------------------------------------------------------

const W = '/w'
const F = {
  api: `${W}/src/main/mobile-api.ts`,
  server: `${W}/src/main/mobile-server.ts`,
  grant: `${W}/src/main/owner-grant.ts`,
  store: `${W}/src/main/agent-export.ts`,
  bridge: `${W}/src/main/grant-bridge.ts`,
  gate: `${W}/src/main/call-gate.ts`
}

const CLEAN: Record<string, string> = {
  [F.api]: `import { readJson } from './mobile-http'\nexport const handle = () => readJson()\n`,
  [F.server]: `import { handle } from './mobile-api'\nimport { makeGate } from './call-gate'\nexport const serve = () => handle()\n`,
  [F.gate]: `import type { AgentExport } from './agent-export'\nexport const makeGate = (e: AgentExport) => e\n`,
  [F.grant]: `export class OwnerGrant { enrol(): void {} }\n`,
  [F.store]: `export class AgentExportStore { enrol(): void {} }\n`,
  [`${W}/src/main/mobile-http.ts`]: `export const readJson = (): null => null\n`
}

function sweepFixture(overrides: Record<string, string>): Violation[] {
  return sweepGrantReach(
    {
      roots: [F.api, F.server],
      forbidden: [F.grant, F.store],
      electronAllowed: ELECTRON_ALLOWED,
      relativeTo: W
    },
    virtualSourcePort({ ...CLEAN, ...overrides })
  )
}

const kinds = (vs: Violation[]): string[] => [...new Set(vs.map((v) => v.kind))]

describe('the sweep fires on the mutants that defeated its predecessor', () => {
  it('a clean tree passes', () => {
    expect(sweepFixture({})).toEqual([])
  })

  it('R-G4: the RENAMED mutator, the exact edge that passed before', () => {
    // The operation is no longer called `enrol`. A name list is now stale and
    // silent; the import edge is unchanged.
    const mutant = sweepFixture({
      [F.grant]: `export class OwnerGrant { admitCaller(): void {} }\n`,
      [F.api]: `import { OwnerGrant } from './owner-grant'\n` +
        `export const handle = (g: OwnerGrant) => g.admitCaller()\n`
    })
    expect(kinds(mutant)).toContain('grant-reach')
  })

  it('R-G4: a HELPER IN BETWEEN — the likelier accident — is caught transitively', () => {
    const mutant = sweepFixture({
      [F.bridge]: `import { OwnerGrant } from './owner-grant'\nexport const admit = (g: OwnerGrant) => g\n`,
      [F.api]: `import { admit } from './grant-bridge'\nexport const handle = admit\n`
    })
    const reach = mutant.filter((v) => v.kind === 'grant-reach')
    expect(reach).toHaveLength(1)
    // The whole chain, so the middle hop is visible rather than argued about.
    expect(reach[0].chain).toEqual([
      'src/main/mobile-api.ts',
      'src/main/grant-bridge.ts',
      'src/main/owner-grant.ts'
    ])
  })

  it('an import BELOW an exported function is still seen', () => {
    // The shape every real file has and no toy fixture does. This sweep shipped
    // blind to it: scanning lazily from `export function foo(` ran to the next
    // `from '...'` far below and resumed past it, so every import after the
    // first export vanished. The synthetic mutants above all passed while the
    // real tree's did not — which is the whole argument for running both.
    const mutant = sweepFixture({
      [F.api]: `export function first(): null { return null }\n` +
        `export function second(x: string): string { return x }\n` +
        `import { OwnerGrant } from './owner-grant'\n` +
        `export const handle = (g: OwnerGrant) => g\n`
    })
    expect(kinds(mutant)).toContain('grant-reach')
  })

  it('a re-export cannot launder the reach through a barrel', () => {
    const mutant = sweepFixture({
      [F.bridge]: `export { OwnerGrant } from './owner-grant'\n`,
      [F.api]: `import { OwnerGrant } from './grant-bridge'\nexport const handle = OwnerGrant\n`
    })
    expect(kinds(mutant)).toContain('grant-reach')
  })

  it('the STORE beneath the surface is the same power by a longer road', () => {
    const mutant = sweepFixture({
      [F.api]: `import { AgentExportStore } from './agent-export'\n` +
        `export const handle = (op: string) => new AgentExportStore()[op]()\n`
    })
    expect(kinds(mutant)).toContain('grant-reach')
  })

  it('R-G5: the COMPUTED CHANNEL, which never spells a channel name', () => {
    const mutant = sweepFixture({
      [F.api]: `import { ipcMain } from 'electron'\n` +
        'export const handle = (ops: string[]) => ops.forEach((op) => ipcMain.handle(`grant:${op}`, () => 0))\n'
    })
    // Both refusals land: the primitive itself, and an electron binding nobody
    // put on the allow-list. Either alone would have been enough.
    expect(kinds(mutant)).toContain('ipc-primitive')
    expect(kinds(mutant)).toContain('electron-surface')
  })

  it('a namespace import of electron carries the primitives with it', () => {
    const mutant = sweepFixture({
      [F.api]: `import * as electron from 'electron'\nexport const handle = () => electron\n`
    })
    expect(kinds(mutant)).toContain('electron-surface')
  })

  it('a new electron binding fails by DEFAULT rather than by being listed', () => {
    const mutant = sweepFixture({
      [F.api]: `import { webContents } from 'electron'\nexport const handle = () => webContents\n`
    })
    expect(kinds(mutant)).toContain('electron-surface')
  })

  it('a COMPUTED dynamic specifier is BLOCKED, not passed over', () => {
    // The stated residual. The walk cannot follow this edge, and an edge nobody
    // can follow is the one place a grant could hide from a static proof.
    const mutant = sweepFixture({
      [F.api]: `export const handle = async (m: string) => await import(m)\n`
    })
    expect(kinds(mutant)).toEqual(['unresolvable-import'])
  })

  it('a LITERAL dynamic import is followed like any other edge', () => {
    const mutant = sweepFixture({
      [F.api]: `export const handle = async () => await import('./owner-grant')\n`
    })
    expect(kinds(mutant)).toContain('grant-reach')
  })
})

describe('the sweep does not fire on what a listener legitimately does', () => {
  it('a type-only import of the grant record is erased before it runs', () => {
    // The gate must read a grant's shape. `import type` carries no reach, and
    // over-firing here would make the sweep something people turn off.
    expect(
      sweepFixture({
        [F.api]: `import type { AgentExport } from './agent-export'\n` +
          `export const handle = (e: AgentExport) => e\n`
      })
    ).toEqual([])
  })

  it('an inline type specifier in a mixed clause is not reach either', () => {
    expect(
      sweepFixture({
        [F.api]: `import { type AgentExport } from './agent-export'\n` +
          `export const handle = (e: AgentExport) => e\n`
      })
    ).toEqual([])
  })

  it('prose may discuss the rule it cannot break', () => {
    expect(
      sweepFixture({
        [F.api]: `// anyone who could reach ipcMain here would mount grant:enrol\n` +
          `/* import { OwnerGrant } from './owner-grant' */\n` +
          `export const handle = (): null => null\n`
      })
    ).toEqual([])
  })

  it('an allowed electron binding is not a violation', () => {
    expect(
      sweepFixture({
        [F.api]: `import { powerSaveBlocker } from 'electron'\n` +
          `export const handle = () => powerSaveBlocker.start('prevent-app-suspension')\n`
      })
    ).toEqual([])
  })
})
