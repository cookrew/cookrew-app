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
//
// Flags: --port --data --seed --origin --chain --terms-ttl. The origin defaults to the port that is
// bound; pass it only to serve a ceremony on a host other than localhost, and a
// value that contradicts --port refuses at boot.
import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { RegistryStore } from './store'
import { TransparencyLog } from './log'
import { createRegistry } from './server'
import { IdentityService, identityConfigFor } from './identity'
import { makeAuthorize } from './authorize'
import { PayoutStore } from './payouts'
import { DEFAULT_TERMS_CONFIG, MemoryPaymentNonces } from './terms'
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
/**
 * M2-A1. How long a 402 quote stands, in ms — SETTABLE, and that is a test
 * requirement rather than a convenience. A gate cannot sleep out a real
 * fifteen-minute TTL, so without this flag the "expired payment" case is
 * unjudgeable from outside the process. Same shape and same reason as the
 * challenge TTL identity.ts already carries.
 */
const TERMS_TTL_MS = Number(flag('terms-ttl', String(DEFAULT_TERMS_CONFIG.ttlMs)))
const CHAIN = flag('chain', DEFAULT_TERMS_CONFIG.chain)
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

// A2: identity is live. The origin and the rpId must be what a browser will
// actually send, so both are derived from the address this process binds — and
// a contradiction refuses at boot rather than turning every ceremony into a
// blanket 401 that reads like a broken passkey (Tinker's LOW-1).
const resolved = identityConfigFor({ port: PORT, origin: args.includes('--origin') ? flag('origin', '') : undefined })
if (!resolved.ok) {
  console.error(`refusing to start: ${resolved.reason}`)
  process.exit(1)
}
const identity = new IdentityService(DATA, resolved.config)

if (!Number.isInteger(TERMS_TTL_MS) || TERMS_TTL_MS < 1) {
  console.error(`refusing to start: --terms-ttl ${flag('terms-ttl', '')} is not a positive number of ms`)
  process.exit(1)
}
// The price step. Present here because the dev registry sells things; a
// deployment that passes no pricing behaves exactly as M1 did.
const pricing = {
  payouts: new PayoutStore(DATA),
  config: { chain: CHAIN, ttlMs: TERMS_TTL_MS },
  nonces: new MemoryPaymentNonces(),
  now: () => Date.now()
}

createRegistry({
  store,
  log,
  identity,
  pricing,
  dev: true,
  authorize: makeAuthorize(store, identity, pricing)
}).listen(PORT, () => {
  // Print the ORIGIN, not a different spelling of the same port. The old banner
  // said 127.0.0.1 while identity accepted only localhost, so the server was
  // advertising the one address on which nobody could authenticate.
  console.log(`registry on ${resolved.config.origin}  data=${DATA}`)
  for (const p of store.list()) {
    console.log(`  ${p.name.padEnd(16)} v${String(p.version).padEnd(3)} ${p.visibility.padEnd(11)} ${p.id}`)
  }
})
