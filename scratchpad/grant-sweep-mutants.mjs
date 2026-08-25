#!/usr/bin/env node
/**
 * The grant sweep, run against mutants of the REAL tree.
 *
 * The test file's own mutants run on a synthetic tree, which proves the
 * ANALYSER fires. It does not prove the sweep is pointed at the right roots
 * with the right forbidden modules — a correct analyser aimed at nothing passes
 * everything. So these mutate the actual source, run the actual suite, and
 * assert RED. Every mutant is reverted whether it passes or throws.
 *
 *   node scratchpad/grant-sweep-mutants.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = (rel) => path.join(ROOT, rel)

const API = 'src/main/mobile-api.ts'
const SERVER = 'src/main/mobile-server.ts'
const GRANT = 'src/main/owner-grant.ts'
const BRIDGE = 'src/main/grant-bridge.ts'

/**
 * Each mutant lists the files it edits and the violation kind it must produce.
 * `expect: 'red'` throughout — a mutant the sweep tolerates is the finding.
 */
const MUTANTS = [
  {
    id: 'M1-alias',
    why: "Magpie's R-G4: the operation is renamed, so a name list is stale and silent",
    edits: [
      [GRANT, (s) => `${s}\n/** A refactor renamed it. Same power, different name. */\nexport function admitCaller(\n  grant: OwnerGrant, workspaceId: string, sub: string, jwk: Record<string, unknown>\n): GrantResult {\n  return grant.enrol(workspaceId, sub, jwk)\n}\n`],
      [API, (s) => `${s}\nimport { admitCaller } from "./owner-grant";\nexport function mountGrantOnTheWire(deps: any, body: any): unknown {\n  return admitCaller(deps.grants, body.workspaceId, body.sub, body.jwk);\n}\n`]
    ]
  },
  {
    id: 'M2-helper',
    why: 'a helper in between defeats a one-hop rule, and is the likelier accident',
    edits: [
      [BRIDGE, () => `import { OwnerGrant } from "./owner-grant";\nexport const admit = (g: OwnerGrant, w: string, s: string, k: Record<string, unknown>) =>\n  g.enrol(w, s, k);\n`],
      [API, (s) => `${s}\nimport { admit } from "./grant-bridge";\nexport const grantRoute = (d: any, b: any): unknown => admit(d.g, b.w, b.s, b.k);\n`]
    ]
  },
  {
    id: 'M3-computed-channel',
    why: "Magpie's R-G5: `grant:${op}` never spells a channel name a literal search knows",
    edits: [
      [API, (s) => `${s}\nimport { ipcMain } from "electron";\nexport function bridgeHttpToIpc(ops: readonly string[]): void {\n  for (const op of ops) {\n    ipcMain.handle(\`grant:\${op}\`, (_e, ...args: unknown[]) => args);\n  }\n}\n`]
    ]
  },
  {
    id: 'M4-store-direct',
    why: 'the store beneath the surface is the same power by a longer road',
    edits: [
      [API, (s) => `${s}\nimport { AgentExportStore } from "./agent-export";\nexport const widen = (op: string, a: any): unknown => (new AgentExportStore() as any)[op](a);\n`]
    ]
  },
  {
    id: 'M5-deep-chain',
    why: 'reach is transitive to a fixpoint, not to a fixed depth',
    edits: [
      [BRIDGE, () => `import { OwnerGrant } from "./owner-grant";\nexport const admit = (g: OwnerGrant) => g;\n`],
      ['src/main/grant-hop2.ts', () => `import { admit } from "./grant-bridge";\nexport const hop = admit;\n`],
      ['src/main/grant-hop3.ts', () => `import { hop } from "./grant-hop2";\nexport const hop3 = hop;\n`],
      [SERVER, (s) => `${s}\nimport { hop3 } from "./grant-hop3";\nexport const deepGrant = hop3;\n`]
    ]
  },
  {
    id: 'M6-computed-specifier',
    why: 'an edge nobody can follow is BLOCKED, not treated as absent',
    edits: [
      [API, (s) => `${s}\nexport const load = async (m: string): Promise<unknown> => await import(m);\n`]
    ]
  }
]

function runSweep() {
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/grant-surface-shape.test.ts'], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8'
    })
    return { green: true, output: '' }
  } catch (error) {
    return { green: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function detailsFrom(output) {
  const lines = output.split('\n').filter((l) => /listener reaches|BLOCKED|touches ipc|electron binding|namespace import/.test(l))
  return [...new Set(lines.map((l) => l.trim().replace(/^[-+\s]*/, '')))].slice(0, 3)
}

const results = []

const baseline = runSweep()
results.push({ id: 'M0-clean', green: baseline.green, expected: true, why: 'the unmutated tree' })

for (const mutant of MUTANTS) {
  const saved = mutant.edits.map(([rel]) => {
    try {
      return [rel, readFileSync(file(rel), 'utf8')]
    } catch {
      return [rel, null]
    }
  })
  try {
    for (const [rel, edit] of mutant.edits) {
      const current = saved.find(([r]) => r === rel)[1]
      writeFileSync(file(rel), edit(current ?? ''))
    }
    const run = runSweep()
    results.push({
      id: mutant.id,
      green: run.green,
      expected: false,
      why: mutant.why,
      caught: run.green ? [] : detailsFrom(run.output)
    })
  } finally {
    for (const [rel, original] of saved) {
      if (original === null) execFileSync('rm', ['-f', file(rel)])
      else writeFileSync(file(rel), original)
    }
  }
}

let failures = 0
console.log('\n  GRANT SWEEP — MUTANTS AGAINST THE REAL TREE\n')
for (const r of results) {
  const ok = r.green === r.expected
  if (!ok) failures += 1
  const verdict = r.green ? 'PASSED (green)' : 'CAUGHT (red)'
  console.log(`  ${ok ? '✓' : '✗'} ${r.id.padEnd(22)} ${verdict.padEnd(15)} ${r.why}`)
  for (const line of r.caught ?? []) console.log(`      ↳ ${line}`)
}
console.log(
  `\n  ${results.length - failures}/${results.length} as expected` +
    (failures === 0 ? ' — every mutant the old sweep walked past is now RED.\n' : ` — ${failures} WRONG.\n`)
)
process.exit(failures === 0 ? 0 : 1)
