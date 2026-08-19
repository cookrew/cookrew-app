import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { verifyPreset, reviewSheetPayload, planInstall } from '../src/main/preset-install'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { canonicalJson } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const terminal = (over: Record<string, unknown> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'npm test',
    cwd: '/Users/drej/workspace/cookrew-dev',
    orch: false,
    role: 'Developer',
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    ...over
  }) as CanvasNode

const note = (content: string, id = 'n1'): CanvasNode =>
  ({
    kind: 'note',
    id,
    name: 'n',
    customName: null,
    content,
    locked: false,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNode

const snapshot = (nodes: CanvasNode[] = [terminal()]): TeamSnapshot => ({
  name: 'crew',
  savedAt: 1_700_000_000_000,
  dir: '/Users/drej/workspace/cookrew-dev',
  nodes,
  connections: [],
  turns: {}
})

/** A real published preset: scrubbed, built, signed. */
function publish(nodes?: CanvasNode[]): {
  manifest: import('../src/shared/preset-manifest').PresetManifest
  teamBytes: Buffer
  publicKey: import('node:crypto').KeyObject
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const out = buildManifest({ scrub: scrubForPublish(snapshot(nodes)), version: 2, author: { handle: 'drej' } })
  if (!out.ok) throw new Error('build refused')
  return { manifest: signManifest(out.manifest, privateKey), teamBytes: out.teamBytes, publicKey }
}

describe('verifyPreset — the client checks signature AND hashes for itself', () => {
  it('accepts a well-formed signed preset', () => {
    const p = publish()
    const v = verifyPreset(p)
    expect(v.ok).toBe(true)
  })

  it('rejects a tampered team file even though the signature is intact', () => {
    const p = publish()
    const swapped = Buffer.from(canonicalJson({ ...snapshot(), name: 'evil' }), 'utf8')
    const v = verifyPreset({ ...p, teamBytes: swapped })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toBe('hash_mismatch')
  })

  it('rejects a manifest signed by someone else', () => {
    const p = publish()
    const other = generateKeyPairSync('ed25519')
    const v = verifyPreset({ ...p, publicKey: other.publicKey })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toBe('signature_invalid')
  })

  it('rejects an unsigned manifest rather than treating it as merely unverified', () => {
    const p = publish()
    const v = verifyPreset({ ...p, manifest: { ...p.manifest, sig: undefined } })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toBe('unsigned')
  })

  it('rejects a schema it does not implement', () => {
    const p = publish()
    const v = verifyPreset({
      ...p,
      manifest: { ...p.manifest, schema: 'cookrew.preset/2' as never }
    })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toBe('schema_unsupported')
  })

  it('rejects a team file that is not a snapshot', () => {
    const p = publish()
    const v = verifyPreset({ ...p, teamBytes: Buffer.from('not json', 'utf8') })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(['hash_mismatch', 'malformed_team']).toContain(v.reason)
  })

  it('catches a manifest whose signed report UNDERSTATES what the team carries', () => {
    // Both the report and the team hash are signed, so a mismatch is the author
    // lying in the sheet — the one attack a valid signature cannot rule out.
    const p = publish([terminal({ preset: 'Shell', command: 'rm -rf /' }), note('a')])
    const lying = signManifest(
      { ...p.manifest, scrub: { ...p.manifest.scrub, shells: 0 } },
      generateKeyPairSync('ed25519').privateKey
    )
    // Re-sign under a key we then verify with, so only the mismatch can fail it.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const resigned = signManifest({ ...lying, sig: undefined }, privateKey)
    const v = verifyPreset({ manifest: resigned, teamBytes: p.teamBytes, publicKey })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toBe('report_mismatch')
  })
})

describe('reviewSheetPayload — R14: spec tokens verbatim, never prose', () => {
  const verified = (nodes?: CanvasNode[]): Extract<ReturnType<typeof verifyPreset>, { ok: true }> => {
    const v = verifyPreset(publish(nodes))
    if (!v.ok) throw new Error(`verify failed: ${v.reason}`)
    return v
  }

  it('carries the scrub tokens exactly as the spec spells them', () => {
    const sheet = reviewSheetPayload(verified())
    expect(sheet.scrub.paths).toBe('placeholders')
    expect(sheet.scrub.secretScan).toBe('clean')
    expect(typeof sheet.scrub.sessions).toBe('boolean')
  })

  it('shows every shell command VERBATIM — it is what the buyer is agreeing to run', () => {
    const sheet = reviewSheetPayload(
      verified([terminal({ preset: 'Shell', command: 'rm -rf ./build' }), terminal({ id: 't2' })])
    )
    expect(sheet.shellCommands).toEqual(['rm -rf ./build'])
  })

  it('reports counts from the SIGNED report, which verify has already reconciled', () => {
    const sheet = reviewSheetPayload(verified([terminal({ preset: 'Shell', command: 'x' }), note('a'), note('b')]))
    expect(sheet.scrub.shells).toBe(1)
    expect(sheet.scrub.notes).toBe(2)
  })

  it('names the author by the key that signed, not by a display string alone', () => {
    const sheet = reviewSheetPayload(verified())
    expect(sheet.author.keyId).toMatch(/^ed25519:/)
    expect(sheet.author.handle).toBe('drej')
  })

  it('states the version being installed', () => {
    expect(reviewSheetPayload(verified()).version).toBe(2)
  })

  it('emits no human-facing prose at all — the UI owns wording', () => {
    const sheet = reviewSheetPayload(verified())
    // Every value is a token, a count, a boolean or verbatim user content.
    expect(Object.keys(sheet).sort()).toEqual(
      ['author', 'id', 'pricing', 'schema', 'scrub', 'shellCommands', 'version'].sort()
    )
  })
})

describe('planInstall — verify, then place IDLE', () => {
  it('only plans from a verified preset, and lands the node unbound', () => {
    const v = verifyPreset(publish())
    if (!v.ok) throw new Error('verify failed')
    const plan = planInstall(v, { dirs: ['/home/buyer/app'], cutAt: 9 })
    expect(plan.kind).toBe('single')
    if (plan.kind !== 'single') return
    expect(plan.node.claudeSessionId ?? null).toBeNull()
    expect(plan.node.cwd).toBe('/home/buyer/app')
  })

  it('records the version and the manifest it came from', () => {
    const v = verifyPreset(publish())
    if (!v.ok) throw new Error('verify failed')
    const plan = planInstall(v, { dirs: ['/home/buyer/app'], cutAt: 9 })
    expect(plan.pin.version).toBe(1)
    expect(plan.pin.manifestId).toBe(v.manifest.id)
  })
})
