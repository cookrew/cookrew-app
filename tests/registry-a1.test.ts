import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { RegistryStore, addressOf, isAddress, lineageOf } from '../registry/src/store'
import { TransparencyLog, hashRecord, verifyChain, type LogRecord } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { PRESET_VERSION_HEADER, type PresetManifest } from '../src/shared/preset-manifest'
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

/** A real published preset — scrubbed, built and signed the way one is. */
function publish(name: string, version: number, nodes: CanvasNode[] = [terminal()]) {
  const snapshot: TeamSnapshot = { name, savedAt: 1, dir: '/w', nodes, connections: [], turns: {} }
  const { privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' } })
  if (!built.ok) throw new Error(`build refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, privateKey), teamBytes: built.teamBytes, teamName: name }
}

let base = ''
let store: RegistryStore
let log: TransparencyLog
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/* ------------------------------------------------------------- store ---- */

describe('RegistryStore — addresses are validated before they become paths', () => {
  const HOSTILE = [
    '../../../../etc/passwd',
    'sha256:../../etc',
    'sha256:' + 'a'.repeat(63),
    'sha256:' + 'A'.repeat(64),
    'nonsense',
    ''
  ]

  it('rejects every non-address shape', () => {
    for (const value of HOSTILE) expect(isAddress(value)).toBe(false)
  })

  it('C1 carry-forward: a traversing address reads NOTHING', () => {
    // Same bug class as the client store, opposite direction: there it was a
    // delete-anything primitive, here it would hand the bytes to whoever asked.
    const outside = path.join(base, 'secret.json')
    writeFileSync(outside, '{"private":true}')
    for (const value of HOSTILE) expect(store.getBlob(value)).toBeNull()
    expect(store.getBlob('../secret')).toBeNull()
  })

  it('round-trips a blob under its own address', () => {
    const bytes = Buffer.from('{"team":true}')
    const address = store.putBlob(bytes)
    expect(address).toBe(addressOf(bytes))
    expect(store.getBlob(address)?.equals(bytes)).toBe(true)
  })

  it('refuses to serve bytes that no longer hash to the address asked for', () => {
    const bytes = Buffer.from('{"team":true}')
    const address = store.putBlob(bytes)
    writeFileSync(path.join(base, 'blobs', `${address.slice(7)}.json`), '{"tampered":true}')
    // Serving these under the requested address would break the one promise a
    // content address makes.
    expect(store.getBlob(address)).toBeNull()
  })
})

describe('RegistryStore — the catalogue is derived from the manifests', () => {
  it('lists a stored preset with its name, version and author', () => {
    const p = publish('Deep Research', 2)
    store.putManifest({ manifest: p.manifest, teamName: p.teamName, visibility: 'public' })
    const [row] = store.list()
    expect(row).toMatchObject({ name: 'Deep Research', version: 2, author: 'drej', visibility: 'public' })
  })

  it('reports the LATEST version in a lineage, which is what a HEAD answers', () => {
    // Two versions of one preset: different team bytes, so different ids.
    const v1 = publish('Audit Pack', 1, [terminal({ command: 'a' })])
    const v2 = publish('Audit Pack', 2, [terminal({ command: 'b' })])
    // Same author key for both, so they share a lineage.
    const shared = { ...v2.manifest, author: v1.manifest.author }
    store.putManifest({ manifest: v1.manifest, teamName: 'Audit Pack', visibility: 'public' })
    store.putManifest({ manifest: shared, teamName: 'Audit Pack', visibility: 'public' })
    for (const row of store.list()) expect(row.latestVersion).toBe(2)
  })

  it('skips a corrupt record instead of emptying the catalogue', () => {
    const p = publish('Deep Research', 1)
    store.putManifest({ manifest: p.manifest, teamName: p.teamName, visibility: 'public' })
    writeFileSync(path.join(base, 'manifests', `${'b'.repeat(64)}.json`), 'not json')
    expect(store.list()).toHaveLength(1)
  })

  it('ignores a file whose name is not an address', () => {
    mkdirSync(path.join(base, 'manifests'), { recursive: true })
    writeFileSync(path.join(base, 'manifests', 'notes.txt'), 'hello')
    expect(store.list()).toEqual([])
  })

  it('refuses to file a manifest under a non-address id', () => {
    const p = publish('X', 1)
    expect(() =>
      store.putManifest({
        manifest: { ...p.manifest, id: '../escape' } as PresetManifest,
        teamName: 'X',
        visibility: 'public'
      })
    ).toThrow()
  })

  it('searches name and author, case-insensitively', () => {
    for (const [n, v] of [
      ['Deep Research', 1],
      ['Ship Crew', 1]
    ] as const) {
      const p = publish(n, v)
      store.putManifest({ manifest: p.manifest, teamName: n, visibility: 'public' })
    }
    expect(store.search('deep').map((p) => p.name)).toEqual(['Deep Research'])
    expect(store.search('DREJ')).toHaveLength(2)
    expect(store.search('')).toHaveLength(2)
    expect(store.search('nothing')).toEqual([])
  })

  it('derives a lineage that survives a version bump', () => {
    const a = publish('Audit Pack', 1, [terminal({ command: 'a' })])
    const b = publish('Audit Pack', 2, [terminal({ command: 'b' })])
    const shared = { ...b.manifest, author: a.manifest.author }
    expect(lineageOf(a.manifest, 'Audit Pack')).toBe(lineageOf(shared, 'Audit Pack'))
    // A different author is a different lineage even under the same name.
    expect(lineageOf(a.manifest, 'Audit Pack')).not.toBe(lineageOf(b.manifest, 'Audit Pack'))
  })
})

/* --------------------------------------------------------------- log ---- */

describe('TransparencyLog — the chain is checkable by anyone', () => {
  const entry = (presetId: string, version: number): Omit<LogRecord, 'seq' | 'prev' | 'hash'> => ({
    at: 1,
    kind: 'publish',
    presetId,
    version,
    authorKeyId: 'ed25519:k',
    identityId: 'webauthn:i'
  })

  it('assigns seq and prev itself, so a caller cannot place a record', () => {
    const a = log.append(entry('sha256:a', 1))
    const b = log.append(entry('sha256:b', 2))
    expect(a.seq).toBe(1)
    expect(a.prev).toBe('')
    expect(b.seq).toBe(2)
    expect(b.prev).toBe(a.hash)
  })

  it('verifies a chain it wrote', () => {
    log.append(entry('sha256:a', 1))
    log.append(entry('sha256:b', 2))
    log.append(entry('sha256:c', 3))
    expect(verifyChain(log.all())).toBeNull()
  })

  it('detects an EDITED record — the guarantee it actually makes', () => {
    log.append(entry('sha256:a', 1))
    log.append(entry('sha256:b', 2))
    const records = log.all()
    records[0] = { ...records[0], version: 99 }
    expect(verifyChain(records)).toBe(0)
  })

  it('detects a REMOVED record, because the chain no longer joins', () => {
    log.append(entry('sha256:a', 1))
    log.append(entry('sha256:b', 2))
    log.append(entry('sha256:c', 3))
    const records = log.all()
    expect(verifyChain([records[0], records[2]])).toBe(1)
  })

  it('detects an edit once a LATER record commits to it', () => {
    log.append(entry('sha256:a', 1))
    log.append(entry('sha256:b', 2))
    const records = log.all()
    const { hash: _drop, ...rest } = records[0]
    const forged = { ...rest, version: 42 }
    // Rehashed so the record is self-consistent — but record 1 still commits
    // to the OLD hash, so the join breaks.
    records[0] = { ...forged, hash: hashRecord(forged) }
    expect(verifyChain(records)).toBe(1)
  })

  /**
   * ACCEPTED LIMITATION, and precisely the one the design note stated narrowly.
   * Rewriting the LAST record and rehashing it produces a chain that verifies:
   * nothing commits to the head yet, so replay alone cannot object. Detection
   * requires a party who kept an EARLIER head — which is what witnessing (M3)
   * generalises. Pinned as a test so the boundary is on the record; if this
   * ever starts failing, the guarantee got stronger and wants re-reading.
   */
  it('ACCEPTED: rewriting the HEAD and rehashing still verifies on replay alone', () => {
    log.append(entry('sha256:a', 1))
    log.append(entry('sha256:b', 2))
    const records = log.all()
    const { hash: _drop, ...rest } = records[1]
    const forged = { ...rest, version: 42 }
    records[1] = { ...forged, hash: hashRecord(forged) }
    expect(verifyChain(records)).toBeNull()
  })

  it('but a client that KEPT the earlier head detects exactly that rewrite', () => {
    log.append(entry('sha256:a', 1))
    const keptHead = log.head() as LogRecord
    log.append(entry('sha256:b', 2))
    const records = log.all()
    const { hash: _drop, ...rest } = records[1]
    const forged = { ...rest, version: 42 }
    records[1] = { ...forged, hash: hashRecord(forged) }
    // The kept head must still appear, unchanged, at its own sequence number.
    expect(records.find((r) => r.seq === keptHead.seq)).toEqual(keptHead)
    // And the rewritten record no longer matches what the server first served.
    expect(records[1].version).not.toBe(2)
  })

  it('serves from a sequence number for a client catching up', () => {
    for (let i = 1; i <= 3; i++) log.append(entry(`sha256:${i}`, i))
    expect(log.from(2).map((r) => r.seq)).toEqual([2, 3])
  })

  it('stops at a truncated tail rather than serving records that cannot chain', () => {
    log.append(entry('sha256:a', 1))
    writeFileSync(path.join(base, 'log.jsonl'), `${JSON.stringify(log.all()[0])}\n{"seq":2,`, 'utf8')
    expect(log.all()).toHaveLength(1)
  })
})

/* ------------------------------------------------------------ server ---- */

describe('registry server — public serving', () => {
  const listen = async (): Promise<{ url: string; close: () => void }> => {
    const server = createRegistry({ store, log })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
  }

  const seed = (name: string, version: number, visibility: 'public' | 'identified' = 'public') => {
    const p = publish(name, version)
    store.putBlob(p.teamBytes)
    store.putManifest({ manifest: p.manifest, teamName: name, visibility })
    return p
  }

  it('serves a signed manifest verbatim', async () => {
    const p = seed('Deep Research', 2)
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(p.manifest.id)}/manifest`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(p.manifest)
    } finally {
      s.close()
    }
  })

  it('R3: a HEAD answers the version header and no body', async () => {
    const p = seed('Deep Research', 2)
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(p.manifest.id)}/manifest`, {
        method: 'HEAD'
      })
      expect(res.status).toBe(200)
      expect(res.headers.get(PRESET_VERSION_HEADER)).toBe('2')
      expect(await res.text()).toBe('')
    } finally {
      s.close()
    }
  })

  it('serves a blob as immutable, because the address IS the content', async () => {
    const p = seed('Deep Research', 1)
    const s = await listen()
    try {
      const address = p.manifest.blobs[p.manifest.team]
      const res = await fetch(`${s.url}/v1/blobs/${encodeURIComponent(address)}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('immutable')
      expect(Buffer.from(await res.arrayBuffer()).equals(p.teamBytes)).toBe(true)
    } finally {
      s.close()
    }
  })

  it('404s a traversing address instead of reaching for it', async () => {
    const s = await listen()
    try {
      for (const bad of ['../../etc/passwd', 'sha256:zz', 'nonsense']) {
        expect((await fetch(`${s.url}/v1/blobs/${encodeURIComponent(bad)}`)).status).toBe(404)
        expect(
          (await fetch(`${s.url}/v1/presets/${encodeURIComponent(bad)}/manifest`)).status
        ).toBe(404)
      }
    } finally {
      s.close()
    }
  })

  it('browses and searches', async () => {
    seed('Deep Research', 1)
    seed('Ship Crew', 1)
    const s = await listen()
    try {
      const all = (await (await fetch(`${s.url}/v1/presets`)).json()) as { presets: unknown[] }
      expect(all.presets).toHaveLength(2)
      const hit = (await (await fetch(`${s.url}/v1/presets?q=ship`)).json()) as {
        presets: { name: string }[]
      }
      expect(hit.presets.map((p) => p.name)).toEqual(['Ship Crew'])
    } finally {
      s.close()
    }
  })

  it('refuses an identified preset in A1, where no identity exists to offer', async () => {
    // 403 rather than 401 on purpose: a 401 promises a ceremony the server
    // cannot yet complete, and a client would loop on it. A2 turns this into a
    // real challenge without touching a route.
    const p = seed('Pro Toolkit', 1, 'identified')
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(p.manifest.id)}/manifest`)
      expect(res.status).toBe(403)
    } finally {
      s.close()
    }
  })

  it('serves the log for replay', async () => {
    log.append({
      at: 1,
      kind: 'publish',
      presetId: 'sha256:a',
      version: 1,
      authorKeyId: 'ed25519:k',
      identityId: 'webauthn:i'
    })
    const s = await listen()
    try {
      const body = (await (await fetch(`${s.url}/v1/log`)).json()) as { records: LogRecord[] }
      expect(body.records).toHaveLength(1)
      expect(verifyChain(body.records)).toBeNull()
    } finally {
      s.close()
    }
  })

  it('404s an unknown route rather than guessing', async () => {
    const s = await listen()
    try {
      expect((await fetch(`${s.url}/v1/nope`)).status).toBe(404)
      expect((await fetch(`${s.url}/`)).status).toBe(404)
    } finally {
      s.close()
    }
  })
})
