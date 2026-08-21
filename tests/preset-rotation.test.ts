import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { verifyPreset } from '../src/main/preset-install'
import { buildManifest, keyIdOf, publicKeyFromId, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { PresetStore } from '../src/main/preset-store'
import { presetChips, chipAction, chipBadgeAction } from '../src/shared/preset-chip'
import {
  rotationSheetPayload,
  shouldRaiseRotationSheet,
  transparencyLogUrl,
  type KeyRotation
} from '../src/shared/preset-rotation'
import {
  MKT_ROTATION,
  authorLabel,
  fillCopy,
  rotationSheetCopy,
  shortKeyId,
  unknownDenialCopy,
  versionLabel
} from '../src/shared/marketplace-copy'
import { canonicalJson, type ForbiddenBody, type PresetManifest } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * R20 CLIENT HALF — the author rotated their signing key.
 *
 * The registry's half (TOFU, countersignature, the log record) shipped in A3.
 * This is what the BUYER meets: a refusal that is not an accusation, raised as a
 * sheet exactly once, and left standing on the chip until they decide.
 */

const terminal = (command = 'npm test'): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command,
    cwd: '/w',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  }) as CanvasNode

const snapshot = (name = 'crew', command = 'npm test'): TeamSnapshot => ({
  name,
  savedAt: 1,
  dir: '/w',
  nodes: [terminal(command)],
  connections: [],
  turns: {}
})

function authored(key: KeyObject, over: { name?: string; version?: number; command?: string } = {}) {
  const built = buildManifest({
    scrub: scrubForPublish(snapshot(over.name ?? 'crew', over.command ?? 'npm test')),
    version: over.version ?? 1,
    author: { handle: 'drej' }
  })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, key), teamBytes: built.teamBytes }
}

let oldKey: { publicKey: KeyObject; privateKey: KeyObject }
let newKey: { publicKey: KeyObject; privateKey: KeyObject }

beforeEach(() => {
  oldKey = generateKeyPairSync('ed25519')
  newKey = generateKeyPairSync('ed25519')
})

describe('verifyPreset — a rotation is its own refusal, not a forgery', () => {
  it('names author_key_changed when a sound manifest is signed by a key we did not pin', () => {
    const { manifest, teamBytes } = authored(newKey.privateKey)
    const result = verifyPreset({ manifest, teamBytes, publicKey: oldKey.publicKey })
    expect(result).toEqual({ ok: false, reason: 'author_key_changed' })
  })

  it('still verifies normally against the key it was pinned to', () => {
    const { manifest, teamBytes } = authored(oldKey.privateKey)
    const result = verifyPreset({ manifest, teamBytes, publicKey: oldKey.publicKey })
    expect(result.ok).toBe(true)
  })

  it('refuses a FORGED key swap as signature_invalid — a rotation sheet must not be reachable by tampering', () => {
    // The one attack the friendly wording would otherwise buy: swap the stated
    // author to a key you control, keep the old signature, and collect a sheet
    // whose single button is "TRUST THE NEW KEY".
    const { manifest, teamBytes } = authored(oldKey.privateKey)
    const swapped: PresetManifest = {
      ...manifest,
      author: { ...manifest.author, keyId: keyIdOf(newKey.publicKey) }
    }
    expect(verifyPreset({ manifest: swapped, teamBytes, publicKey: oldKey.publicKey })).toEqual({
      ok: false,
      reason: 'signature_invalid'
    })
  })

  it('refuses a rotated manifest whose bytes do not match — content failures outrank the rotation', () => {
    const { manifest } = authored(newKey.privateKey)
    const other = Buffer.from(canonicalJson(snapshot('other')), 'utf8')
    expect(verifyPreset({ manifest, teamBytes: other, publicKey: oldKey.publicKey })).toEqual({
      ok: false,
      reason: 'hash_mismatch'
    })
  })

  it('refuses a rotated manifest whose scrub report lies — likewise', () => {
    const { manifest, teamBytes } = authored(newKey.privateKey)
    const lying: PresetManifest = { ...manifest, scrub: { ...manifest.scrub, commands: 0 } }
    // The report is inside the signature, so re-sign with the new key: the
    // point is that report_mismatch wins over author_key_changed, not that an
    // unsigned edit is caught (it is, by signature_invalid).
    const resigned = signManifest(lying, newKey.privateKey)
    expect(verifyPreset({ manifest: resigned, teamBytes, publicKey: oldKey.publicKey })).toEqual({
      ok: false,
      reason: 'report_mismatch'
    })
  })

  it('refuses a key id that does not round-trip to itself, and RETURNS while doing it', () => {
    // The rotation branch re-checks a manifest against the key it claims. An
    // earlier draft did that by calling verifyPreset again, which a key id that
    // normalises to something else — base64 padding is enough, and Node imports
    // it happily — would have bounced between the two branches until the stack
    // ran out. A hostile registry chooses this field, so the loop was a denial
    // of service for the price of one '=' character.
    const { manifest, teamBytes } = authored(newKey.privateKey)
    const padded: PresetManifest = {
      ...manifest,
      author: { ...manifest.author, keyId: `${manifest.author.keyId}=` }
    }
    expect(verifyPreset({ manifest: padded, teamBytes, publicKey: oldKey.publicKey })).toEqual({
      ok: false,
      reason: 'signature_invalid'
    })
  })

  it('refuses every unusable key id without throwing', () => {
    const { manifest, teamBytes } = authored(newKey.privateKey)
    for (const keyId of ['', 'ed25519:', 'ed25519:not-base64!!', 'rsa:abc', 'x'.repeat(4096)]) {
      const claimed: PresetManifest = { ...manifest, author: { ...manifest.author, keyId } }
      const result = verifyPreset({ manifest: claimed, teamBytes, publicKey: oldKey.publicKey })
      expect(result).toEqual({ ok: false, reason: 'signature_invalid' })
    }
  })

  it('refuses an unsigned rotated manifest as unsigned', () => {
    const { manifest, teamBytes } = authored(newKey.privateKey)
    const { sig: _sig, ...unsigned } = manifest
    void _sig
    expect(
      verifyPreset({ manifest: unsigned as PresetManifest, teamBytes, publicKey: oldKey.publicKey })
    ).toEqual({ ok: false, reason: 'unsigned' })
  })
})

describe('PresetStore — the rotation is local state, and it OUTLIVES the sheet', () => {
  let base = ''
  let store: PresetStore
  let installedId = ''

  const install = (key: KeyObject = oldKey.privateKey): string => {
    const { manifest, teamBytes } = authored(key)
    store.install({ manifest, teamBytes })
    return manifest.id
  }

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'preset-rotation-'))
    store = new PresetStore(base)
    installedId = install()
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('trusts the key pinned at install until told otherwise', () => {
    expect(store.trustedKeyId(installedId)).toBe(keyIdOf(oldKey.publicKey))
    expect(store.rotationOf(installedId)).toBeNull()
  })

  it('records a rotation with the pinned key as the OLD one, unseen', () => {
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1_700_000_000_000 })
    expect(store.rotationOf(installedId)).toEqual({
      oldKeyId: keyIdOf(oldKey.publicKey),
      newKeyId: keyIdOf(newKey.publicKey),
      at: 1_700_000_000_000,
      sheetSeen: false
    })
  })

  it('ignores a "rotation" to the key already trusted — that is not an event', () => {
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(oldKey.publicKey), at: 1 })
    expect(store.rotationOf(installedId)).toBeNull()
  })

  it('remembers the sheet was seen ACROSS PROCESSES — once as a sheet, never once as a fact', () => {
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    store.markRotationSheetSeen(installedId)
    const reopened = new PresetStore(base)
    const rotation = reopened.rotationOf(installedId)
    expect(rotation?.sheetSeen).toBe(true)
    // The FACT survives: the chip still says KEY CHANGED.
    expect(rotation?.newKeyId).toBe(keyIdOf(newKey.publicKey))
    expect(shouldRaiseRotationSheet(rotation)).toBe(false)
  })

  it('does not re-raise the sheet when the same rotation is met again', () => {
    // Every dock open re-checks; re-learning the same key must not re-interrupt.
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    store.markRotationSheetSeen(installedId)
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 2 })
    expect(store.rotationOf(installedId)?.sheetSeen).toBe(true)
  })

  it('DOES raise it again when the key rotates a second time to something new', () => {
    const third = generateKeyPairSync('ed25519')
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    store.markRotationSheetSeen(installedId)
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(third.publicKey), at: 2 })
    const rotation = store.rotationOf(installedId)
    expect(rotation?.newKeyId).toBe(keyIdOf(third.publicKey))
    expect(shouldRaiseRotationSheet(rotation)).toBe(true)
  })

  it('keeps the entitlement cache when it writes rotation state, and vice versa', () => {
    const gatedId = (() => {
      const { manifest, teamBytes } = authored(oldKey.privateKey, { name: 'gated' })
      store.install({ manifest, teamBytes }, { entitled: false })
      return manifest.id
    })()
    store.noteKeyRotation(gatedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    const chip = store.list().find((p) => p.id === gatedId)
    expect(chip?.entitled).toBe(false)
    expect(chip?.keyChanged?.newKeyId).toBe(keyIdOf(newKey.publicKey))
  })

  it('surfaces the rotation on the installed list so the dock can badge it', () => {
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    expect(store.list().find((p) => p.id === installedId)?.keyChanged?.sheetSeen).toBe(false)
  })

  it('trusts the new key on the buyer\'s word — and the installed version KEEPS WORKING', () => {
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    store.trustAuthorKey(installedId, keyIdOf(newKey.publicKey))
    expect(store.trustedKeyId(installedId)).toBe(keyIdOf(newKey.publicKey))
    // The rotation is resolved, so the badge clears and the update badge can
    // arrive normally afterwards (deck 5d, mkt.rotation.trusted).
    expect(store.rotationOf(installedId)).toBeNull()
    // The installed bytes are still signed by the OLD key — trusting the new
    // one must not evict the version the buyer is running.
    expect(store.read(installedId)).not.toBeNull()
    expect(store.list().map((p) => p.id)).toContain(installedId)
  })

  it('verifies the NEXT download against the trusted key once the buyer accepts', () => {
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    store.trustAuthorKey(installedId, keyIdOf(newKey.publicKey))
    const next = authored(newKey.privateKey, { version: 2, command: 'npm run build' })
    const trusted = store.trustedKeyId(installedId)
    expect(trusted).not.toBeNull()
    const result = verifyPreset({
      manifest: next.manifest,
      teamBytes: next.teamBytes,
      publicKey: publicKeyFromId(trusted as string)
    })
    expect(result.ok).toBe(true)
  })

  it('refuses to trust a key over a preset it does not hold, and touches nothing', () => {
    store.trustAuthorKey('../../../etc', keyIdOf(newKey.publicKey))
    store.noteKeyRotation('not-an-address', { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    expect(store.rotationOf('not-an-address')).toBeNull()
    expect(store.trustedKeyId('not-an-address')).toBeNull()
  })

  it('treats a rotation written for a preset with no pinned key as absent', () => {
    // A half-written install has no author.pub; there is no OLD key to name, so
    // there is no rotation to describe either.
    const dir = path.join(base, 'presets', `sha256-${'b'.repeat(64)}`)
    rmSync(dir, { recursive: true, force: true })
    expect(store.rotationOf(`sha256:${'b'.repeat(64)}`)).toBeNull()
  })

  it('survives a corrupt local-state file rather than losing the chip', () => {
    const dir = path.join(base, 'presets', `sha256-${installedId.slice('sha256:'.length)}`)
    writeFileSync(path.join(dir, 'install.json'), '{ not json')
    expect(store.rotationOf(installedId)).toBeNull()
    expect(store.list().map((p) => p.id)).toContain(installedId)
    // And a later write repairs it instead of throwing.
    store.noteKeyRotation(installedId, { newKeyId: keyIdOf(newKey.publicKey), at: 1 })
    expect(store.rotationOf(installedId)?.newKeyId).toBe(keyIdOf(newKey.publicKey))
    expect(JSON.parse(readFileSync(path.join(dir, 'install.json'), 'utf8'))).toHaveProperty('rotation')
  })
})

describe('the chip — where the decision lives after the sheet is dismissed', () => {
  const rotation: KeyRotation = {
    oldKeyId: 'ed25519:old',
    newKeyId: 'ed25519:new',
    at: 1,
    sheetSeen: true
  }
  const installed = (over = {}) => ({
    id: 'sha256:a',
    name: 'Deep Research',
    version: 2,
    members: ['Claude Code'],
    entitled: true,
    ...over
  })

  it('wears KEY CHANGED once a rotation is known', () => {
    expect(presetChips([installed({ keyChanged: rotation })])[0].badge).toBe('key-changed')
  })

  it('shows KEY CHANGED over an update — the update is the thing that will be refused', () => {
    const [chip] = presetChips([installed({ keyChanged: rotation, version: 2, headVersion: 3 })])
    expect(chip.badge).toBe('key-changed')
    expect(chip.headVersion).toBeUndefined()
  })

  it('still shows the LOCK over a rotation — an unentitled preset has a nearer problem', () => {
    const [chip] = presetChips([installed({ keyChanged: rotation, entitled: false })])
    expect(chip.badge).toBe('lock')
  })

  it('STILL PLACES — "your installed version keeps working" has to be true of the click too', () => {
    expect(chipAction(presetChips([installed({ keyChanged: rotation })])[0])).toBe('place')
  })

  it('re-opens the rotation sheet from the badge, which is the only way back to it', () => {
    expect(chipBadgeAction(presetChips([installed({ keyChanged: rotation })])[0])).toBe('rotation')
    expect(chipBadgeAction(presetChips([installed({ entitled: false })])[0])).toBe('gate')
    expect(chipBadgeAction(presetChips([installed({ version: 2, headVersion: 3 })])[0])).toBe('update')
    expect(chipBadgeAction(presetChips([installed()])[0])).toBe('none')
  })
})

describe('the sheet — raised once, on the buyer\'s own click', () => {
  it('raises while unseen and never again after', () => {
    const unseen: KeyRotation = { oldKeyId: 'a', newKeyId: 'b', at: 1, sheetSeen: false }
    expect(shouldRaiseRotationSheet(unseen)).toBe(true)
    expect(shouldRaiseRotationSheet({ ...unseen, sheetSeen: true })).toBe(false)
    expect(shouldRaiseRotationSheet(null)).toBe(false)
    expect(shouldRaiseRotationSheet(undefined)).toBe(false)
  })

  it('builds a payload of tokens only — R14, no prose, no status code', () => {
    const payload = rotationSheetPayload({
      presetId: 'sha256:aa',
      presetName: 'Deep Research',
      authorHandle: 'drej',
      currentVersion: 2,
      rotation: { oldKeyId: 'ed25519:old', newKeyId: 'ed25519:new', at: 1_700_000_000_000, sheetSeen: false },
      registryBase: 'https://market.cookrew.dev'
    })
    expect(payload).toEqual({
      presetId: 'sha256:aa',
      presetName: 'Deep Research',
      authorHandle: 'drej',
      currentVersion: 2,
      oldKeyId: 'ed25519:old',
      newKeyId: 'ed25519:new',
      at: 1_700_000_000_000,
      logUrl: 'https://market.cookrew.dev/v1/log?preset=sha256%3Aaa'
    })
    // Nothing in the payload is a sentence.
    for (const value of Object.values(payload)) {
      if (typeof value === 'string') expect(value).not.toMatch(/\s\w+\s\w+\s/)
    }
  })

  it('points the log link at the records for THIS preset, so the buyer can check us', () => {
    expect(transparencyLogUrl('https://market.cookrew.dev/', 'sha256:aa')).toBe(
      'https://market.cookrew.dev/v1/log?preset=sha256%3Aaa'
    )
  })
})

describe('mkt.rotation.* — Velvet\'s deck section 5d, lifted verbatim', () => {
  it('carries all eleven ids and no others', () => {
    expect(Object.keys(MKT_ROTATION).sort()).toEqual(
      [
        'mkt.rotation.action',
        'mkt.rotation.chip',
        'mkt.rotation.dismiss',
        'mkt.rotation.evidence.log',
        'mkt.rotation.evidence.new',
        'mkt.rotation.evidence.old',
        'mkt.rotation.evidence.when',
        'mkt.rotation.refused',
        'mkt.rotation.survived',
        'mkt.rotation.title',
        'mkt.rotation.trusted'
      ].sort()
    )
  })

  it('is the deck\'s wording to the byte', () => {
    expect(MKT_ROTATION['mkt.rotation.title']).toBe('{author} changed signing keys')
    expect(MKT_ROTATION['mkt.rotation.survived']).toBe(
      'Your installed version keeps working. Nothing changed on your canvas.'
    )
    expect(MKT_ROTATION['mkt.rotation.refused']).toBe(
      "Cookrew won't install updates signed with the new key until you accept it."
    )
    expect(MKT_ROTATION['mkt.rotation.evidence.old']).toBe('previously signed by {oldKeyId}')
    expect(MKT_ROTATION['mkt.rotation.evidence.new']).toBe('now signing with {newKeyId}')
    expect(MKT_ROTATION['mkt.rotation.evidence.when']).toBe(
      'rotated {date} · countersigned by the same account'
    )
    expect(MKT_ROTATION['mkt.rotation.evidence.log']).toBe('view in the transparency log')
    expect(MKT_ROTATION['mkt.rotation.action']).toBe('TRUST THE NEW KEY')
    expect(MKT_ROTATION['mkt.rotation.dismiss']).toBe('Keep v{current}')
    expect(MKT_ROTATION['mkt.rotation.chip']).toBe('KEY CHANGED')
    expect(MKT_ROTATION['mkt.rotation.trusted']).toBe('Now trusting {newKeyId} for {presetName}.')
  })

  it('never says "security", never accuses, never shows a status code (R14)', () => {
    for (const copy of Object.values(MKT_ROTATION)) {
      expect(copy.toLowerCase()).not.toContain('security')
      expect(copy.toLowerCase()).not.toContain('alert')
      expect(copy).not.toMatch(/\b40[0-9]\b/)
      expect(copy.toLowerCase()).not.toContain('cancel')
    }
  })

  it('renders every string of the sheet with nothing left unfilled', () => {
    const copy = rotationSheetCopy(
      {
        presetId: 'sha256:aa',
        presetName: 'Deep Research',
        authorHandle: 'drej',
        currentVersion: 2,
        oldKeyId: 'ed25519:oldkeymaterialaaaaaaaa',
        newKeyId: 'ed25519:newkeymaterialbbbbbbbb',
        at: 1_700_000_000_000,
        logUrl: 'https://market.cookrew.dev/v1/log?preset=sha256%3Aaa'
      },
      { date: '14 November 2023' }
    )
    expect(copy['mkt.rotation.title']).toBe('drej changed signing keys')
    expect(copy['mkt.rotation.dismiss']).toBe('Keep v2')
    expect(copy['mkt.rotation.evidence.when']).toBe(
      'rotated 14 November 2023 · countersigned by the same account'
    )
    expect(copy['mkt.rotation.trusted']).toBe('Now trusting ed25519:newkeyma… for Deep Research.')
    for (const value of Object.values(copy)) expect(value).not.toMatch(/[{}]/)
  })

  it('shows key ids SHORT, and marks them as shortened', () => {
    expect(shortKeyId('ed25519:abcdefghijklmnop')).toBe('ed25519:abcdefgh…')
    // Already short enough to read whole — no misleading ellipsis.
    expect(shortKeyId('ed25519:abcd')).toBe('ed25519:abcd')
    expect(shortKeyId('nonsense')).toBe('nonsense')
  })

  it('throws on a placeholder nobody filled rather than rendering a brace at a buyer', () => {
    expect(() => fillCopy('{author} changed signing keys', {})).toThrow(/author/)
  })
})

describe('mkt.denied.unknown — the forward-compatibility contract (deck section 5)', () => {
  it('sends the buyer to the author when there IS somewhere to send them', () => {
    const copy = unknownDenialCopy('https://author.example/support')
    expect(copy.title).toBe("Your license doesn't cover this preset")
    expect(copy.action).toBe("OPEN AUTHOR'S PAGE")
  })

  it('FABRICATES NO REMEDY when the denial carries none — Velvet\'s copy-check', () => {
    // `scope` is the live case: a disagreement between our client and our
    // registry. Pointing the buyer at an author's page would send them to
    // somebody who cannot fix it.
    for (const absent of [undefined, '']) {
      const copy = unknownDenialCopy(absent)
      expect(copy.title).toBe("Cookrew couldn't complete that")
      expect(copy.body).toBe('Nothing was installed and nothing was charged.')
      expect(copy.action).toBe('COPY DETAILS')
      expect(copy.body.toLowerCase()).not.toContain('author')
      expect(copy.action.toLowerCase()).not.toContain('author')
    }
  })

  it('renders a sentence for a reason this client has never heard of', () => {
    // The contract itself: never the raw token, never a blank sheet. A future
    // reason arrives at a client already installed, so this ships in M1.
    const future = { reason: 'quota_exhausted' } as unknown as ForbiddenBody
    const copy = unknownDenialCopy(future.remedy)
    expect(copy.title).not.toContain(future.reason)
    expect(copy.title.length).toBeGreaterThan(0)
    expect(copy.body).toMatch(/\.$/)
  })
})

describe('deck section 7 rules every marketplace surface shares', () => {
  it('R8: v1–v9 are labelled, 10 and above are bare, and nothing is rounded', () => {
    expect([1, 5, 9].map(versionLabel)).toEqual(['v1', 'v5', 'v9'])
    expect([10, 42, 99].map(versionLabel)).toEqual(['10', '42', '99'])
    // 100+ is a FLAG on the rail — an affordance, not a spelling. The exact
    // version still renders, because a wrong version is worse than an absent
    // one and no string may truncate one.
    expect([100, 1287].map(versionLabel)).toEqual(['100', '1287'])
  })

  it('writes an author as @handle, and never doubles an @ they typed', () => {
    expect(authorLabel('drej')).toBe('@drej')
    expect(authorLabel('@drej')).toBe('@drej')
  })
})
