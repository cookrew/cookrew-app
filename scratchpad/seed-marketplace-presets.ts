// Seed the installed-presets store so a served build shows REAL marketplace
// chips (M1 §8). For Magpie's chip place/paste gate: three presets covering
// every chip state the dock can draw.
//
//   1. "Deep Research"  single agent, owned      → plain chip, arms placement
//   2. "Ship Crew"      team of three, owned     → stacked chip, arms a paste
//   3. "Pro Toolkit"    team of two, GATED       → lock badge, opens the sheet
//
// Nothing here is faked at the seam: each preset is scrubbed by the real
// scrubber, built into a real cookrew.preset/1 manifest, signed with a real
// ed25519 key, and VERIFIED through the real install path before it is
// persisted. A preset that would not survive a genuine download does not get
// written — so a green chip row is evidence, not decoration.
//
// The signing key is generated per run and thrown away. That is deliberate: a
// seed must never leave a reusable publishing identity on a QA machine.
//
// Usage:  npx esbuild --bundle scratchpad/seed-marketplace-presets.ts \
//           --format=esm --platform=node --outfile=/tmp/seed-presets.mjs
//         node /tmp/seed-presets.mjs [--base <dir>] [--clean]
//
//   --base <dir>  data dir to seed (default ~/.cookrew) — point it at a temp
//                 dir to inspect the output without touching a real store
//   --clean       uninstall the three seeded ids first, so re-running is
//                 idempotent rather than additive

import { generateKeyPairSync } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { PresetStore } from '../src/main/preset-store'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { verifyPreset } from '../src/main/preset-install'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const args = process.argv.slice(2)
const baseAt = args.indexOf('--base')
const BASE = baseAt >= 0 ? args[baseAt + 1] : path.join(homedir(), '.cookrew')
const CLEAN = args.includes('--clean')

/** An author's machine — the scrubber replaces these with placeholders. */
const AUTHOR_DIR = '/Users/author/workspace/lab'

let seq = 0
const terminal = (name: string, preset: string, command = ''): CanvasNode =>
  ({
    kind: 'terminal',
    id: `seed-t${++seq}`,
    name,
    preset,
    command,
    cwd: AUTHOR_DIR,
    orch: false,
    role: name,
    position: { x: 40 * seq, y: 40 * seq },
    size: { width: 420, height: 300 }
  }) as CanvasNode

const note = (content: string): CanvasNode =>
  ({
    kind: 'note',
    id: `seed-n${++seq}`,
    name: 'brief',
    customName: null,
    content,
    locked: false,
    position: { x: 0, y: 320 },
    size: { width: 280, height: 180 }
  }) as CanvasNode

const snapshot = (name: string, nodes: CanvasNode[]): TeamSnapshot => ({
  name,
  savedAt: Date.now(),
  dir: AUTHOR_DIR,
  dirs: [AUTHOR_DIR],
  nodes,
  connections: [],
  turns: {}
})

interface Seed {
  snapshot: TeamSnapshot
  version: number
  entitled: boolean
}

const SEEDS: Seed[] = [
  {
    // Exactly one node, on purpose: the import planner calls a preset "single"
    // when it ships ONE node, not one terminal, so adding even a brief note
    // here would turn this into a team paste and lose the single-chip case.
    snapshot: snapshot('Deep Research', [terminal('Scout', 'Claude Code')]),
    version: 2,
    entitled: true
  },
  {
    snapshot: snapshot('Ship Crew', [
      terminal('Forge', 'Claude Code'),
      terminal('Tinker', 'Codex'),
      terminal('Runner', 'Shell', 'npm run build'),
      note('Ship Crew — Forge implements, Tinker fixes, Runner builds.')
    ]),
    version: 4,
    entitled: true
  },
  {
    snapshot: snapshot('Pro Toolkit', [
      terminal('Auditor', 'Claude Code'),
      terminal('Sweeper', 'Shell', 'rm -rf ./dist')
    ]),
    version: 1,
    entitled: false
  }
]

function seedOne(store: PresetStore, seed: Seed): { id: string; name: string; entitled: boolean } {
  const scrub = scrubForPublish(seed.snapshot)
  if (!scrub.ok) {
    // The seed itself must pass the publish gate. If a fixture ever trips the
    // secret scanner, that is a bug in the fixture, not a reason to bypass it.
    throw new Error(
      `seed "${seed.snapshot.name}" blocked by secret scan: ${scrub.report.findings
        .map((f) => `${f.kind}@${f.where}`)
        .join(', ')}`
    )
  }
  const built = buildManifest({
    scrub,
    version: seed.version,
    author: { handle: 'cookrew-seed' }
  })
  if (!built.ok) throw new Error(`seed "${seed.snapshot.name}" build refused: ${built.reason}`)

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifest = signManifest(built.manifest, privateKey)

  // The buyer's own check, run before anything is written: signature, blob
  // hashes, and the signed scrub report against the actual team file.
  const verified = verifyPreset({ manifest, teamBytes: built.teamBytes, publicKey })
  if (!verified.ok) throw new Error(`seed "${seed.snapshot.name}" failed verify: ${verified.reason}`)

  store.install({ manifest, teamBytes: built.teamBytes }, { entitled: seed.entitled })
  return { id: manifest.id, name: seed.snapshot.name, entitled: seed.entitled }
}

const store = new PresetStore(BASE)

if (CLEAN) {
  for (const row of store.list()) {
    if (SEEDS.some((s) => s.snapshot.name === row.name)) store.uninstall(row.id)
  }
}

const written = SEEDS.map((seed) => seedOne(store, seed))

console.log(`seeded ${written.length} presets into ${path.join(BASE, 'presets')}\n`)
for (const row of store.list()) {
  const kind = row.members.length > 1 ? 'team' : 'single'
  const badge = row.entitled ? '' : '  [LOCK]'
  console.log(
    `  ${row.name.padEnd(16)} v${String(row.version).padEnd(3)} ${kind.padEnd(6)} ` +
      `${row.members.join(' + ')}${badge}`
  )
}
console.log(
  '\nExpected chips: 1 single (arms placement), 1 stacked team (arms a paste),' +
    '\n1 stacked team with a lock badge (opens the gate sheet, does not place).'
)
console.log('\nRemove them again with:  node <this>.mjs --clean  (then re-run without --clean)')
