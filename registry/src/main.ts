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
//   POST /v2/accounts                claim a username with a password (identity v2)
//   POST /v2/sessions                sign in; the server sets cr_session HttpOnly
//   GET  /v2/me                      the reader's devices, desktops and security
//   GET  /me                         the same, as a page
//   POST /v2/me/desktops/:id/cert    a Mac's own certificate, by ACME dns-01
//   GET  /v2/me/desktops/:id/cert    pending / issued / failed
//
// REACH v2.1 flags, ALL OPTIONAL and off by default:
//   --dns-port 8753          bind UDP+TCP DNS on this port. Absent → no listener.
//   --dns-zone d.cookrew.dev the zone we are authoritative for.
//   --dns-ns ns1.d.cookrew.dev=1.2.3.4,ns2.d.cookrew.dev=5.6.7.8
//                            the NS records and their glue — the same values
//                            typed once at the parent zone.
//   --acme-directory <url>   default Let's Encrypt STAGING. Production is
//                            always an explicit value: a typo must not be able
//                            to spend the real 50-a-week allowance.
//   --acme-email <addr>      optional contact on the ACME account.
// Absent flags mean nothing listens and nothing changes.
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
import { DEFAULT_TERMS_CONFIG } from './terms'
import { FilePaymentNonces } from './payment-nonces'
import { devFacilitator } from './facilitator-dev'
import { ReceiptStore } from './receipts'
import { DoorStore } from './doors'
import { StarStore } from './stars'
import { ReleaseCache } from './releases'
import { CommitsCache } from './github-commits'
import { Pulse } from './pulse'
import { createV2 } from './v2-routes'
import { AcmeClient, LETSENCRYPT_STAGING } from './acme-client'
import { createNames, type NamesFeature } from './names'
import { createDnsServer } from './dns-server'
import type { NameServer } from './dns-zone'
import { buildManifest, signManifest } from '../../src/main/preset-publish'
import { scrubForPublish } from '../../src/main/preset-scrub'
import type { TeamSnapshot } from '../../src/main/teams'
import type { CanvasNode } from '../../src/shared/model'

// This process holds every served door's downlink. A promise nobody awaited
// must be a log line, never the end of the process.
process.on('unhandledRejection', (reason) => {
  console.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
})

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
/**
 * DEVELOPMENT MODE, and it is OFF unless asked for.
 *
 * It was `true` here, unconditionally, because this file began as a dev-only
 * entry point. The moment the same binary was deployed at cookrew.dev that
 * constant published `/v1/dev/identities` — a list of every enrolled
 * credential, and a DELETE that forgets all of them — to the open internet.
 *
 * A deployment either was started for development or it was not. That is a
 * decision made at boot by whoever ran it, never a default, and never
 * something a reader has to infer from which file the flag lives in.
 */
const DEV = args.includes('--dev')

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
// The v2 half, built before the names half because the DNS zone reads its
// desktops: one store of where a Mac is, answered on two protocols.
const v2 = createV2(DATA, { origin: resolved.config.origin })

/**
 * REACH v2.1 — DNS AND ACME, ASSEMBLED ONLY IF ASKED FOR.
 *
 * Both flags together or neither: a port with no name servers would serve an
 * SOA naming nobody, and name servers with no port would be a promise nothing
 * answers. A malformed value REFUSES AT BOOT rather than starting a listener
 * that quietly answers the wrong glue — the parent zone's records are typed by
 * hand once and have to match these exactly.
 */
const nameServers = (spec: string): NameServer[] | null => {
  if (spec === '') return null
  const out: NameServer[] = []
  for (const entry of spec.split(',')) {
    const [host, address] = entry.split('=')
    if (!host || !address || !host.includes('.')) return null
    out.push({ host: host.trim().toLowerCase(), address: address.trim() })
  }
  return out.length === 0 ? null : out
}

const DNS_PORT = Number(flag('dns-port', '0'))
const DNS_ZONE = flag('dns-zone', 'd.cookrew.dev').toLowerCase()
const DNS_NS = nameServers(flag('dns-ns', ''))
const ACME_DIRECTORY = flag('acme-directory', LETSENCRYPT_STAGING)
const ACME_EMAIL = flag('acme-email', '')

let names: NamesFeature | undefined
if (DNS_PORT > 0 || DNS_NS !== null) {
  if (!Number.isInteger(DNS_PORT) || DNS_PORT < 1 || DNS_PORT > 65535) {
    console.error(`refusing to start: --dns-port ${flag('dns-port', '')} is not a port`)
    process.exit(1)
  }
  if (DNS_NS === null) {
    console.error('refusing to start: --dns-port needs --dns-ns host=address,host=address')
    process.exit(1)
  }
  names = createNames({
    zone: DNS_ZONE,
    ns: DNS_NS,
    dataDir: DATA,
    // The DNS gate reads the SAME store the /me page does: a name exists only
    // while that Mac is publishing that address, and there is exactly one
    // place that fact lives.
    desktops: {
      find: (deviceId) => v2.accounts.desktopFor(deviceId),
      changedAt: () => v2.accounts.desktopsChangedAt()
    },
    acme: new AcmeClient({
      directory: ACME_DIRECTORY,
      dataDir: DATA,
      ...(ACME_EMAIL === '' ? {} : { email: ACME_EMAIL }),
      log: (message) => console.log(message)
    }),
    log: (message) => console.log(message)
  })
}

if (!Number.isInteger(TERMS_TTL_MS) || TERMS_TTL_MS < 1) {
  console.error(`refusing to start: --terms-ttl ${flag('terms-ttl', '')} is not a positive number of ms`)
  process.exit(1)
}
// The price step. Present here because the dev registry sells things; a
// deployment that passes no pricing behaves exactly as M1 did.
const pricing = {
  payouts: new PayoutStore(DATA),
  config: { chain: CHAIN, ttlMs: TERMS_TTL_MS },
  // FILE-backed: a quote must outlive the process that issued it, or a buyer
  // who paid mid-flight and met a restart is told their payment is invalid.
  nonces: new FilePaymentNonces(DATA),
  // The DEV facilitator: reaches no chain, verifies no transfer, and exists so
  // the handshake can be driven end to end against the real binary. See its
  // file — it is not a payment system and must never be one.
  facilitator: devFacilitator(),
  receipts: new ReceiptStore(DATA),
  now: () => Date.now()
}

createRegistry({
  store,
  log,
  identity,
  pricing,
  dev: DEV,
  // R30. The directory of teams someone is SERVING, and the relay that carries
  // calls to the ones that cannot be dialled. Both on in the dev binary because
  // the whole point of it is to drive the real path end to end.
  // Dev only: it lists doors on a localhost relay, which a production registry
  // refuses because "anyone with the link" would not be true of them.
  doors: new DoorStore(DATA, { allowPrivate: DEV }),
  relay: true,
  // The address printed on a team's page is something a person copies, so it
  // is the configured origin rather than whatever Host a caller sent.
  origin: resolved.config.origin,
  // The market's sort key and the homepage's download buttons — both real:
  // stars are a file beside the doors, the build is whatever GitHub says.
  stars: new StarStore(DATA),
  releases: new ReleaseCache(),
  commits: new CommitsCache(),
  pulse: new Pulse(DATA),
  // IDENTITY v2 — a username and a password, with devices attached. Built
  // from the same data directory as everything else, and sharing the token
  // key identity.ts already writes there, so one key signs every token this
  // registry mints. A torn account file refuses at boot rather than starting
  // with every name looking free.
  // The origin a browser sees, which is what WebAuthn compares an assertion
  // against — the same string /v1 identity is configured with.
  v2,
  note: (message) => console.error(message),
  ...(names === undefined ? {} : { names }),
  authorize: makeAuthorize(store, identity, pricing)
}).listen(PORT, () => {
  // Print the ORIGIN, not a different spelling of the same port. The old banner
  // said 127.0.0.1 while identity accepted only localhost, so the server was
  // advertising the one address on which nobody could authenticate.
  console.log(`registry on ${resolved.config.origin}  data=${DATA}${DEV ? '  [DEV]' : ''}`)
  if (names !== undefined && DNS_NS !== null) {
    // ONE LINE PER FEATURE, and nothing in either of them that is a secret:
    // the zone, the port and the glue are public by definition (they are typed
    // into the parent zone), and the ACME account key is never printed.
    console.log(`dns on :${DNS_PORT}  zone=${DNS_ZONE}  ns=${DNS_NS.map((n) => `${n.host}=${n.address}`).join(',')}`)
    console.log(`acme directory=${ACME_DIRECTORY}${ACME_EMAIL === '' ? '' : `  contact=${ACME_EMAIL}`}`)
    void createDnsServer({ port: DNS_PORT, respond: names.respond, log: (m) => console.log(m) })
      .start()
      .catch((error: unknown) => {
        // The HTTP half is already serving. A DNS port that will not bind is a
        // loud line and a registry that still answers, never a dead process.
        console.error(`dns did not start: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  for (const p of store.list()) {
    console.log(`  ${p.name.padEnd(16)} v${String(p.version).padEnd(3)} ${p.visibility.padEnd(11)} ${p.id}`)
  }
})
