import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentExportStore } from '../src/main/agent-export'

/**
 * THE GRANT RECORD (④ · S2) — every default is the closed one.
 *
 * These are mostly tests that nothing opens by accident: a missing file, a
 * corrupt file, a half-written entry and an empty caller list must all grant
 * nothing. That is the property the 404 branch of the gate rests on.
 */

let base = ''
let store: AgentExportStore
const WS = 'ws-cookrew-dev'
const NODE = 'node-forge'
const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'abc' }

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-exports-'))
  store = new AgentExportStore(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const writeRaw = (contents: string): void => {
  mkdirSync(base, { recursive: true })
  writeFileSync(path.join(base, 'exports.json'), contents)
}

describe('AgentExportStore — nothing is callable until it is exported', () => {
  it('grants nothing when the file does not exist', () => {
    expect(store.exportOf(WS, NODE)).toBeNull()
    expect(store.enrolledKey(WS, 'alice')).toBeNull()
  })

  it('grants nothing when the file is corrupt', () => {
    writeRaw('{ not json')
    expect(store.exportOf(WS, NODE)).toBeNull()
    expect(store.enrolledKey(WS, 'alice')).toBeNull()
  })

  it('grants nothing when the file is valid JSON of the wrong shape', () => {
    writeRaw('[]')
    expect(store.exportOf(WS, NODE)).toBeNull()
  })

  it('drops a malformed entry without dropping its neighbours', () => {
    // One corrupt record must not open the rest, and must not close them either.
    writeRaw(
      JSON.stringify({
        enrolled: [],
        exports: [
          { workspaceId: WS, nodeId: 'broken' },
          { workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['alice'] }
        ]
      })
    )
    expect(store.exportOf(WS, 'broken')).toBeNull()
    expect(store.exportOf(WS, NODE)?.callers).toEqual(['alice'])
  })

  it('refuses a visibility it does not recognise', () => {
    writeRaw(
      JSON.stringify({
        enrolled: [],
        exports: [{ workspaceId: WS, nodeId: NODE, visibility: 'open', callers: [] }]
      })
    )
    expect(store.exportOf(WS, NODE)).toBeNull()
  })

  it('records and reads back an export', () => {
    store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['alice'] })
    expect(store.exportOf(WS, NODE)).toEqual({
      workspaceId: WS,
      nodeId: NODE,
      visibility: 'identified',
      callers: ['alice']
    })
  })

  it('scopes an export to its workspace — the same node id elsewhere is not it', () => {
    store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['alice'] })
    expect(store.exportOf('ws-playground', NODE)).toBeNull()
  })

  it('replaces a grant rather than accumulating two for one node', () => {
    store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['alice'] })
    store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['bob'] })
    expect(store.exportsIn(WS)).toHaveLength(1)
    expect(store.exportOf(WS, NODE)?.callers).toEqual(['bob'])
  })

  it('refuses to record a public grant — a live call is never public', () => {
    // The gate keeps its public branch and the registry uses it: a free
    // DOWNLOAD is discovery. A call is a stranger running compute on the
    // owner's machine, and with no subject there is nothing to key a
    // conversation on, so anonymous callers would share one fork's transcript.
    expect(() =>
      store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'public', callers: [] })
    ).toThrow(/never public/)
    expect(store.exportOf(WS, NODE)).toBeNull()
  })

  it('drops a public grant already on disk, rather than honouring it', () => {
    // Refusing the write is not enough on its own: a file written by an older
    // build, or by hand, must not open a call path this one would refuse.
    writeRaw(
      JSON.stringify({
        enrolled: [],
        exports: [{ workspaceId: WS, nodeId: NODE, visibility: 'public', callers: [] }]
      })
    )
    expect(store.exportOf(WS, NODE)).toBeNull()
  })

  it('withdraws an export immediately', () => {
    store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['alice'] })
    store.unexport(WS, NODE)
    expect(store.exportOf(WS, NODE)).toBeNull()
  })

  it('survives a reopen — a grant outlives the process that made it', () => {
    store.exportAgent({ workspaceId: WS, nodeId: NODE, visibility: 'identified', callers: ['alice'] })
    expect(new AgentExportStore(base).exportOf(WS, NODE)?.callers).toEqual(['alice'])
  })
})

describe('AgentExportStore — enrolment is TOFU and workspace-scoped', () => {
  it('enrols a caller and reads its key back', () => {
    expect(store.enrol(WS, 'alice', JWK)).toEqual({ ok: true })
    expect(store.enrolledKey(WS, 'alice')).toEqual(JWK)
  })

  it('does not leak an enrolment across workspaces', () => {
    store.enrol(WS, 'alice', JWK)
    expect(store.enrolledKey('ws-playground', 'alice')).toBeNull()
  })

  it('refuses to re-register a known subject under a different key', () => {
    store.enrol(WS, 'alice', JWK)
    const again = store.enrol(WS, 'alice', { ...JWK, x: 'different' })
    expect(again).toEqual({ ok: false, reason: 'caller_exists' })
    expect(store.enrolledKey(WS, 'alice')).toEqual(JWK)
  })

  it('is idempotent for the same subject and the same key', () => {
    store.enrol(WS, 'alice', JWK)
    expect(store.enrol(WS, 'alice', JWK)).toEqual({ ok: true })
  })

  it('refuses an incomplete enrolment', () => {
    expect(store.enrol(WS, '', JWK).ok).toBe(false)
    expect(store.enrol('', 'alice', JWK).ok).toBe(false)
  })

  it('revokes one caller at one workspace and nothing else', () => {
    store.enrol(WS, 'alice', JWK)
    store.enrol(WS, 'bob', JWK)
    store.enrol('ws-playground', 'alice', JWK)
    store.revoke(WS, 'alice')
    expect(store.enrolledKey(WS, 'alice')).toBeNull()
    expect(store.enrolledKey(WS, 'bob')).toEqual(JWK)
    expect(store.enrolledKey('ws-playground', 'alice')).toEqual(JWK)
  })
})
