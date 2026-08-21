// Dev registry entry point (P2-A1 + A2). Public serving plus the 401 path.
//
// Usage:  npx esbuild --bundle registry/src/main.ts \
//           --format=esm --platform=node --outfile=/tmp/registry.mjs
//         node /tmp/registry.mjs [--port 8790] [--data <dir>] [--seed]
//
//   --seed  publish the three seed presets into an EMPTY data dir before
//           serving, so a fresh checkout has something to browse. Refuses on a
//           non-empty store rather than duplicating or overwriting.
//
// Routes (spec §2; codes are the protocol, never chrome — R14):
//   GET  /install/:presetId          the shared link — a plain page, no app needed (R21)
//   GET  /v1/presets?q=              browse / search
//   GET  /v1/presets/:id/manifest    the gate
//   HEAD /v1/presets/:id/manifest    update check, x-cookrew-preset-version (R3)
//   GET  /v1/blobs/:address          immutable content
//   GET  /v1/log?from=&preset=       transparency log, replayable; preset narrows it (R20)
//   POST /v1/identity/register       enrol a credential (TOFU)
//   POST /v1/identity/assert         verify a ceremony, mint a short-lived token
import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { RegistryStore } from './store'
import { TransparencyLog } from './log'
import { createRegistry } from './server'
import { IdentityService, DEV_CONFIG } from './identity'
import { makeAuthorize } from './authorize'
import { buildManifest, signManifest } from '../../src/main/preset-publish'
import { scrubForPublish } from '../../src/main/preset-scrub'
import type { TeamSnapshot } from '../../src/main/teams'
import type { CanvasNode } from '../../src/shared/model'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const PORT = Number(flag('port', '8790'))
const DATA = path.resolve(flag('data', path.join(process.cwd(), 'registry', 'data')))

const store = new RegistryStore(DATA)
const log = new TransparencyLog(DATA)

/** The same three shapes the client seed uses, so both ends demo one story. */
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

const SEEDS: { name: string; version: number; visibility: 'public' | 'identified'; nodes: CanvasNode[] }[] = [
  { name: 'Deep Research', version: 2, visibility: 'public', nodes: [terminal('Scout', 'Claude Code')] },
  {
    name: 'Ship Crew',
    version: 4,
    visibility: 'public',
    nodes: [
      terminal('Forge', 'Claude Code'),
      terminal('Tinker', 'Codex'),
      terminal('Runner', 'Shell', 'npm run build')
    ]
  },
  {
    // The 401 path needs traffic before M2 depends on it (approved in §2 of the
    // design note). In A1 this answers 403 — honest, because no identity exists
    // to offer yet — and A2 turns it into a real challenge with no route change.
    name: 'Pro Toolkit',
    version: 1,
    visibility: 'identified',
    nodes: [terminal('Auditor', 'Claude Code'), terminal('Sweeper', 'Shell', 'rm -rf ./dist')]
  }
]

if (args.includes('--seed')) {
  if (store.list().length > 0) {
    console.error(`refusing to seed: ${DATA} already holds ${store.list().length} preset(s)`)
    process.exit(1)
  }
  for (const seed of SEEDS) {
    const snapshot: TeamSnapshot = {
      name: seed.name,
      savedAt: Date.now(),
      dir: AUTHOR_DIR,
      dirs: [AUTHOR_DIR],
      nodes: seed.nodes,
      connections: [],
      turns: {}
    }
    // Published for real: scrubbed, built, signed. A preset that would not
    // survive a genuine publish is not written, so browsing the dev registry is
    // evidence rather than decoration.
    const scrub = scrubForPublish(snapshot)
    if (!scrub.ok) throw new Error(`seed "${seed.name}" blocked by secret scan`)
    const built = buildManifest({ scrub, version: seed.version, author: { handle: 'cookrew-seed' } })
    if (!built.ok) throw new Error(`seed "${seed.name}" refused: ${built.reason}`)
    const { privateKey } = generateKeyPairSync('ed25519')
    const manifest = signManifest(built.manifest, privateKey)

    store.putBlob(built.teamBytes)
    store.putManifest({
      manifest,
      teamName: seed.name,
      visibility: seed.visibility,
      identityId: 'webauthn:seed'
    })
    log.append({
      at: Date.now(),
      kind: 'publish',
      presetId: manifest.id,
      version: seed.version,
      authorKeyId: manifest.author.keyId,
      // A3 replaces this with a real WebAuthn identity and countersignature.
      identityId: 'webauthn:seed'
    })
  }
  console.log(`seeded ${SEEDS.length} presets into ${DATA}`)
}

// A2: identity is live. The origin must match what the browser will send, so
// it follows the port rather than the DEV_CONFIG default.
const identity = new IdentityService(DATA, { ...DEV_CONFIG, origin: `http://localhost:${PORT}` })

createRegistry({ store, log, identity, dev: true, authorize: makeAuthorize(store, identity) }).listen(PORT, () => {
  console.log(`registry on http://127.0.0.1:${PORT}  data=${DATA}`)
  for (const p of store.list()) {
    console.log(`  ${p.name.padEnd(16)} v${String(p.version).padEnd(3)} ${p.visibility.padEnd(11)} ${p.id}`)
  }
})
