import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import fixture from './fixtures/review-sheet.json'
import { reviewSheetPayload, verifyPreset } from '../src/main/preset-install'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { FORBIDDEN_REASONS } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const shell = (id: string, command: string): CanvasNode =>
  ({
    kind: 'terminal',
    id,
    name: id,
    preset: 'Shell',
    command,
    cwd: '/w',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  }) as CanvasNode

const note = (id: string): CanvasNode =>
  ({
    kind: 'note',
    id,
    name: id,
    customName: null,
    content: 'brief',
    locked: false,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  }) as CanvasNode

const browser = (id: string): CanvasNode =>
  ({
    kind: 'browser',
    id,
    name: id,
    url: 'https://example.com',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  }) as CanvasNode

/** Publish + verify for real, so the fixture is checked against live behaviour. */
function sheetFor(nodes: CanvasNode[], version: number): ReturnType<typeof reviewSheetPayload> {
  const snapshot: TeamSnapshot = {
    name: 'crew',
    savedAt: 1,
    dir: '/w',
    nodes,
    connections: [],
    turns: {}
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' } })
  if (!built.ok) throw new Error('build refused')
  const manifest = signManifest(built.manifest, privateKey)
  const verified = verifyPreset({ manifest, teamBytes: built.teamBytes, publicKey })
  if (!verified.ok) throw new Error(`verify failed: ${verified.reason}`)
  return reviewSheetPayload(verified)
}

/**
 * The fixture is a published contract — Magpie builds gate fixtures from it and
 * the sheet is designed against it — so it must never drift from what the
 * install path actually produces.
 */
describe('review-sheet fixture stays true to the install path', () => {
  it('has the same field set as a real payload', () => {
    const real = sheetFor([note('n1')], 2)
    const fixtureKeys = Object.keys(fixture.clean).filter((k) => !k.startsWith('_'))
    expect(fixtureKeys.sort()).toEqual(Object.keys(real).sort())
  })

  it('matches a real clean single-agent payload field for field', () => {
    const real = sheetFor([note('n1')], 2)
    expect(real.scrub).toEqual(fixture.clean.scrub)
    expect(real.commands).toEqual((fixture.clean as { commands: string[] }).commands)
    expect(real.version).toBe(fixture.clean.version)
  })

  it('spells FREE the same way in the fixture and in the payload: no key', () => {
    // Velvet's falsy catch. The fixture used to say `"pricing": null` while the
    // payload omitted the key — a renderer locking on `pricing === undefined`
    // would have shown a lock on the fixture and none on the real thing.
    expect('pricing' in fixture.clean).toBe(false)
    expect('pricing' in sheetFor([note('n1')], 2)).toBe(false)
  })

  it('matches the shells + notes + urls counts of the loud case', () => {
    const real = sheetFor(
      [shell('s1', 'rm -rf ./build'), shell('s2', 'make deploy'), note('a'), note('b'), note('c'), browser('b1')],
      7
    )
    expect(real.scrub.commands).toBe((fixture.shellsAndSessions.scrub as { commands: number }).commands)
    expect(real.scrub.notes).toBe(fixture.shellsAndSessions.scrub.notes)
    expect(real.scrub.urls).toBe(fixture.shellsAndSessions.scrub.urls)
    expect(real.commands).toEqual((fixture.shellsAndSessions as { commands: string[] }).commands)
  })

  it('lists exactly the 403 vocabulary the code ships', () => {
    expect([...fixture.forbiddenReasons.reasons].sort()).toEqual([...FORBIDDEN_REASONS].sort())
  })

  it('lists every verify failure the install path can return', () => {
    // Each token must be reachable, or the sheet has a branch for a state that
    // cannot happen — and worse, a real refusal with no branch at all.
    expect(fixture.verifyFailures.reasons).toContain('report_mismatch')
    expect(fixture.verifyFailures.reasons).toContain('hash_mismatch')
    expect(new Set(fixture.verifyFailures.reasons).size).toBe(fixture.verifyFailures.reasons.length)
  })

  it('carries no prose — every sheet value is a token, count, boolean or user content', () => {
    for (const key of ['clean', 'shellsAndSessions'] as const) {
      const sheet = fixture[key] as Record<string, unknown>
      expect(typeof sheet.version).toBe('number')
      expect((sheet.scrub as { paths: string }).paths).toBe('placeholders')
      expect(['clean', 'blocked']).toContain((sheet.scrub as { secretScan: string }).secretScan)
    }
  })
})
