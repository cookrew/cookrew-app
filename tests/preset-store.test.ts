import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { PresetStore } from '../src/main/preset-store'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
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

function published(nodes: CanvasNode[] = [terminal()], version = 1, name = 'Deep Research') {
  const snapshot: TeamSnapshot = { name, savedAt: 1, dir: '/w', nodes, connections: [], turns: {} }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' } })
  if (!built.ok) throw new Error('build refused')
  return { manifest: signManifest(built.manifest, privateKey), teamBytes: built.teamBytes, publicKey }
}

let base = ''
let store: PresetStore

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-presets-'))
  store = new PresetStore(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('PresetStore — manifest and blobs land on disk', () => {
  it('installs a verified preset and reads it back byte-for-byte', () => {
    const p = published()
    store.install(p)
    const read = store.read(p.manifest.id)
    expect(read).not.toBeNull()
    expect(read?.teamBytes.equals(p.teamBytes)).toBe(true)
    expect(read?.manifest.id).toBe(p.manifest.id)
  })

  it('is content-addressed on disk, so two versions coexist', () => {
    const v1 = published([terminal()], 1)
    const v2 = published([terminal({ name: 'Forge2' })], 2)
    store.install(v1)
    store.install(v2)
    expect(store.list()).toHaveLength(2)
  })

  it('survives a reopen — the store is the disk, not memory', () => {
    const p = published()
    store.install(p)
    expect(new PresetStore(base).read(p.manifest.id)?.manifest.id).toBe(p.manifest.id)
  })

  it('re-installing the same preset does not duplicate it', () => {
    const p = published()
    store.install(p)
    store.install(p)
    expect(store.list()).toHaveLength(1)
  })
})

describe('PresetStore.list — exactly what the dock chips need', () => {
  it('reports name, version, members and entitlement', () => {
    store.install(published([terminal(), terminal({ id: 't2', preset: 'Codex' })], 3, 'Ship Crew'))
    const [row] = store.list()
    expect(row.name).toBe('Ship Crew')
    expect(row.version).toBe(3)
    expect(row.members).toEqual(['Claude Code', 'Codex'])
    expect(row.entitled).toBe(true)
  })

  it('omits headVersion until a HEAD has answered (R3 asks for it)', () => {
    store.install(published())
    expect(store.list()[0].headVersion).toBeUndefined()
  })

  it('skips a corrupt entry instead of failing the whole dock', () => {
    const p = published()
    store.install(p)
    const junk = path.join(base, 'presets', 'sha256-junk')
    mkdirSync(junk, { recursive: true })
    writeFileSync(path.join(junk, 'manifest.json'), 'not json')
    expect(store.list()).toHaveLength(1)
  })

  it('skips an entry whose blob no longer matches its manifest', () => {
    const p = published()
    store.install(p)
    const dir = path.join(base, 'presets', p.manifest.id.replace(':', '-'))
    writeFileSync(path.join(dir, 'team.json'), '{"name":"tampered","nodes":[]}')
    expect(store.list()).toHaveLength(0)
  })
})

describe('PresetStore.uninstall — A2: placed agents keep working', () => {
  it('removes the preset from the dock', () => {
    const p = published()
    store.install(p)
    store.uninstall(p.manifest.id)
    expect(store.list()).toHaveLength(0)
    expect(store.read(p.manifest.id)).toBeNull()
  })

  it('touches nothing outside its own preset directory', () => {
    const a = published([terminal()], 1, 'A')
    const b = published([terminal({ id: 't9' })], 1, 'B')
    store.install(a)
    store.install(b)
    // A placed agent lives in the WORKSPACE, not here — the closest thing this
    // test can assert is that uninstall is scoped to one directory and leaves
    // every other byte of the store alone.
    const sentinel = path.join(base, 'workspace-sentinel.json')
    writeFileSync(sentinel, '{"placed":true}')
    store.uninstall(a.manifest.id)
    expect(existsSync(sentinel)).toBe(true)
    expect(readFileSync(sentinel, 'utf8')).toBe('{"placed":true}')
    expect(store.read(b.manifest.id)).not.toBeNull()
  })

  it('is a no-op for an id that is not installed', () => {
    expect(() => store.uninstall('sha256:nothing')).not.toThrow()
  })
})
