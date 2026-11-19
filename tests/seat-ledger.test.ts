// A SEAT KEEPS THE PROFILE IT STARTED UNDER (Seatbelt lane, 2026-11-18): the
// ledger, the gate a new remote provider or tunnel asks first, the leftover
// scan, and the refusal to spawn a served workspace as the owner.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SeatLedger, leftoversIn, lsofCwds, seatGate, type SeatRecord } from '../src/main/seat-ledger'
import { inSessionsRoot, profileDigest, servedConfinement, servedProfile, spawnMode, type ServedSpawnContext } from '../src/main/session-spawn'

const seat = (id: string, digest = 'd1'): SeatRecord => ({ terminalId: id, serviceId: 'svc', sandbox: `/s/svc/${id}`, digest })
const none = async (): Promise<string> => ''

describe('spawnMode', () => {
  it('confines with a context, runs the owner without one, and refuses a served workspace that lost its context', () => {
    expect(spawnMode(true, true)).toBe('confined')
    expect(spawnMode(false, true)).toBe('confined')
    expect(spawnMode(false, false)).toBe('owner')
    expect(spawnMode(true, false)).toBe('refuse')
  })
})

describe('inSessionsRoot', () => {
  it('knows a seat by its folder, for workspaces served before they were marked on disk', () => {
    expect(inSessionsRoot('/h/.cookrew/sessions/svc/ana-1', '/h/.cookrew/sessions')).toBe(true)
    expect(inSessionsRoot('/h/.cookrew/sessions/svc/ana-1/work/../x', '/h/.cookrew/sessions')).toBe(true)
    expect(inSessionsRoot('/h/.cookrew/sessions', '/h/.cookrew/sessions')).toBe(true)
    expect(inSessionsRoot('/h/.cookrew/sessions-old/x', '/h/.cookrew/sessions')).toBe(false)
    expect(inSessionsRoot('/h/.cookrew/sessions/../work', '/h/.cookrew/sessions')).toBe(false)
    expect(inSessionsRoot('/h/work', '/h/.cookrew/sessions')).toBe(false)
  })
})

describe('the ledger', () => {
  it('records, replaces and forgets, without changing a list already handed out', () => {
    const ledger = new SeatLedger()
    ledger.record(seat('a'))
    const before = ledger.list()
    ledger.record(seat('b'))
    ledger.record(seat('a', 'd2'))
    expect(before.map((s) => s.terminalId)).toEqual(['a'])
    expect(ledger.list()).toEqual([seat('a', 'd2'), seat('b')])
    ledger.forget('a')
    ledger.forget('missing')
    expect(ledger.list()).toEqual([seat('b')])
  })

  it("lets an old process's exit forget only its own record, not the respawn's", () => {
    const ledger = new SeatLedger()
    const old = seat('a', 'd1')
    ledger.record(old)
    const respawned = seat('a', 'd2')
    ledger.record(respawned)
    ledger.forget('a', old)
    expect(ledger.list()).toEqual([respawned])
    ledger.forget('a', respawned)
    expect(ledger.list()).toEqual([])
  })
})

describe('leftoversIn', () => {
  const listing = ['p10', 'fcwd', 'n/s/svc/a/work', 'p11', 'fcwd', 'n/s/svc/gone', 'p12', 'fcwd', 'n/Users/o', 'p13', 'fcwd', 'n/s/svc/a-evil', 'p14', 'fcwd', 'n/s'].join('\n')

  it('names processes inside the sessions root that no live seat owns', () => {
    expect(leftoversIn(listing, '/s', ['/s/svc/a'])).toEqual([
      { pid: 11, cwd: '/s/svc/gone' },
      // A sibling whose name only starts with a live seat's is not inside it.
      { pid: 13, cwd: '/s/svc/a-evil' },
      { pid: 14, cwd: '/s' }
    ])
    expect(leftoversIn('', '/s', [])).toEqual([])
  })
})

describe('the gate', () => {
  it('is open with nothing stale and nothing left behind', async () => {
    const gate = await seatGate({ seats: [seat('a')], currentDigest: () => 'd1', sessionsRoot: '/s', listCwds: none })
    expect(gate).toEqual({ open: true, stale: [], leftovers: [], why: null })
  })

  it('closes on a seat whose profile is not what a spawn would write now, or cannot be told', async () => {
    const gate = await seatGate({ seats: [seat('a'), seat('b')], currentDigest: (s) => (s.terminalId === 'a' ? 'd2' : null), sessionsRoot: '/s', listCwds: none })
    expect(gate.open).toBe(false)
    expect(gate.stale.map((s) => s.terminalId)).toEqual(['a', 'b'])
    expect(gate.why).toContain('restart them first')
  })

  it('closes on a leftover, and when the scan cannot run', async () => {
    const left = await seatGate({ seats: [], currentDigest: () => null, sessionsRoot: '/s', listCwds: async () => 'p7\nn/s/svc/x' })
    expect(left).toMatchObject({ open: false, leftovers: [{ pid: 7, cwd: '/s/svc/x' }] })
    expect(left.why).toContain('pid 7')
    const blind = await seatGate({ seats: [], currentDigest: () => null, sessionsRoot: '/s', listCwds: async () => null })
    expect(blind).toMatchObject({ open: false, leftovers: null })
  })

  it('sees a lent port taken back: the digest a spawn would write moves', () => {
    const ctx: ServedSpawnContext = { base: '/h/.cookrew', serviceId: 'svc', sessionId: 'svc-1', sandbox: '/h/.cookrew/sessions/svc/1', ownerEnv: {}, loopbackPorts: [5173] }
    const spawned = servedConfinement(ctx, () => undefined)
    expect(spawned.profileDigest).toBe(profileDigest(servedProfile(ctx)))
    expect(profileDigest(servedProfile({ ...ctx, loopbackPorts: [] }))).not.toBe(spawned.profileDigest)
    expect(profileDigest(servedProfile({ ...ctx, gatewayPorts: [4100] }))).not.toBe(spawned.profileDigest)
  })
})

describe.runIf(process.platform === 'darwin')('the leftover scan, for real', () => {
  it('finds a detached process working in a sandbox no live seat owns, and not one in a live seat', async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/sb-left-'))
    const sessions = path.join(root, 'sessions')
    const gone = path.join(sessions, 'svc', 'gone')
    const live = path.join(sessions, 'svc', 'live')
    mkdirSync(gone, { recursive: true })
    mkdirSync(live, { recursive: true })
    const start = (cwd: string): number => {
      const child = spawn('/bin/sleep', ['30'], { cwd, detached: true, stdio: 'ignore' })
      child.unref()
      return child.pid as number
    }
    const orphan = start(gone)
    const owned = start(live)
    try {
      const gate = await seatGate({ seats: [{ terminalId: 't', serviceId: 'svc', sandbox: live, digest: 'd' }], currentDigest: () => 'd', sessionsRoot: sessions, listCwds: lsofCwds })
      expect(gate.open).toBe(false)
      const pids = (gate.leftovers ?? []).map((l) => l.pid)
      expect(pids).toContain(orphan)
      expect(pids).not.toContain(owned)
    } finally {
      for (const pid of [orphan, owned]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
