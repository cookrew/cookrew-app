// The owner's grant surface: who may call what, decided by the owner alone.
//
// "Owner-only IPC" is worth nothing if a page the app merely RENDERS can reach
// the same channel. The app hosts browser cards, an install page, and presets
// that ship URLs — none of which the owner authored. So the sender identity is
// checked, not assumed from the fact that IPC is not HTTP.

import { describe, expect, it, vi } from 'vitest'
import { OwnerGrant, isOwnerSender, GRANT_REASON } from '../src/main/owner-grant'
import type { AgentExportStore } from '../src/main/agent-export'

function fakeStore(over: Partial<AgentExportStore> = {}): AgentExportStore {
  const enrolled = new Map<string, Record<string, unknown>>()
  const exported: unknown[] = []
  return {
    enrol: (ws: string, sub: string, jwk: Record<string, unknown>) => {
      const key = `${ws}:${sub}`
      if (enrolled.has(key)) return { ok: false, reason: 'caller_exists' }
      enrolled.set(key, jwk)
      return { ok: true }
    },
    revoke: (ws: string, sub: string) => void enrolled.delete(`${ws}:${sub}`),
    enrolledKey: (ws: string, sub: string) => enrolled.get(`${ws}:${sub}`) ?? null,
    exportAgent: (grant: unknown) => void exported.push(grant),
    unexport: () => undefined,
    ...over
  } as unknown as AgentExportStore
}

const OWNER = { id: 'owner-webcontents' }
const TOP = { parent: null }

describe('isOwnerSender — a rendered page is not the owner', () => {
  it('accepts the owner window top frame', () => {
    expect(isOwnerSender(OWNER, TOP, OWNER)).toBe(true)
  })

  it('REFUSES a different webContents — a browser card is not the owner', () => {
    // The hole this exists to close. A browser card hosts whatever page the
    // owner browsed to; reaching the grant from there would let a visited site
    // export the owner's agents to the internet.
    expect(isOwnerSender({ id: 'browser-card' }, TOP, OWNER)).toBe(false)
  })

  it('REFUSES an iframe inside the owner window', () => {
    // An install page rendered in a sub-frame of the owner's own window is
    // still not the owner. Same webContents, different authorship.
    expect(isOwnerSender(OWNER, { parent: { id: 'top' } }, OWNER)).toBe(false)
  })

  it('REFUSES a sender it cannot identify', () => {
    // An unidentifiable sender on the surface that decides who reaches the
    // internet is not a tie to break generously.
    expect(isOwnerSender(OWNER, null, OWNER)).toBe(false)
    expect(isOwnerSender(OWNER, undefined, OWNER)).toBe(false)
  })

  it('REFUSES everything before the owner window exists', () => {
    // Boot order must not be a window in which anything is the owner.
    expect(isOwnerSender(OWNER, TOP, null)).toBe(false)
    expect(isOwnerSender(OWNER, TOP, undefined)).toBe(false)
  })
})

describe('a grant is a decision with a record', () => {
  it('records who, to whom, and WHEN', () => {
    // M3's seats and revocation are reads and writes of this same record, and
    // a record that cannot say when a grant was made cannot expire one.
    const audit: unknown[] = []
    const grant = new OwnerGrant({
      store: fakeStore(),
      now: () => 1_700_000_000_000,
      audit: (line) => void audit.push(line)
    })
    grant.enrol('ws-1', 'caller-a', { kty: 'OKP' })

    expect(audit).toEqual([
      { op: 'enrol', workspaceId: 'ws-1', subject: 'caller-a', at: 1_700_000_000_000, via: 'owner-ipc' }
    ])
  })

  it('records the revoke as well as the grant', () => {
    const audit: { op: string }[] = []
    const grant = new OwnerGrant({ store: fakeStore(), audit: (l) => void audit.push(l) })
    grant.enrol('ws-1', 'caller-a', { kty: 'OKP' })
    grant.revoke('ws-1', 'caller-a')
    expect(audit.map((l) => l.op)).toEqual(['enrol', 'revoke'])
  })

  it('an audit that throws does not undo a decision the owner made', () => {
    const store = fakeStore()
    const grant = new OwnerGrant({
      store,
      audit: () => {
        throw new Error('disk full')
      }
    })
    expect(() => grant.enrol('ws-1', 'caller-a', { kty: 'OKP' })).not.toThrow()
    expect(store.enrolledKey('ws-1', 'caller-a')).not.toBeNull()
  })

  it('does not record a decision that was REFUSED', () => {
    // An audit line for something that did not happen is worse than none.
    const audit: unknown[] = []
    const grant = new OwnerGrant({ store: fakeStore(), audit: (l) => void audit.push(l) })
    grant.enrol('ws-1', 'caller-a', { kty: 'OKP' })
    audit.length = 0
    grant.enrol('ws-1', 'caller-a', { kty: 'DIFFERENT' })
    expect(audit).toEqual([])
  })
})

describe('exporting to a caller who cannot use it', () => {
  it('REFUSES an export naming a caller not enrolled here', () => {
    // The gate would refuse the call anyway, so nothing is unsafe — but a
    // grant that silently names a subject who can never use it is a grant the
    // owner BELIEVES they made and did not.
    const grant = new OwnerGrant({ store: fakeStore() })
    const result = grant.exportAgent('ws-1', 'node-1', ['stranger'])
    expect(result).toEqual({ ok: false, reason: GRANT_REASON.notEnrolled })
  })

  it('REFUSES an export naming nobody', () => {
    // Empty means NOBODY, never everybody — the closed default. Accepting it
    // silently would look like a successful export that answers no one.
    const grant = new OwnerGrant({ store: fakeStore() })
    expect(grant.exportAgent('ws-1', 'node-1', [])).toEqual({
      ok: false,
      reason: GRANT_REASON.noCallers
    })
  })

  it('accepts an export to an enrolled caller', () => {
    const store = fakeStore()
    const grant = new OwnerGrant({ store })
    grant.enrol('ws-1', 'caller-a', { kty: 'OKP' })
    expect(grant.exportAgent('ws-1', 'node-1', ['caller-a'])).toEqual({ ok: true })
  })

  it('checks enrolment at THIS workspace, not anywhere', () => {
    // Enrolling a caller to reach one agent must not hand them every agent in
    // every workspace — the scoping the store's own header calls out.
    const store = fakeStore()
    const grant = new OwnerGrant({ store })
    grant.enrol('ws-other', 'caller-a', { kty: 'OKP' })
    expect(grant.exportAgent('ws-1', 'node-1', ['caller-a'])).toEqual({
      ok: false,
      reason: GRANT_REASON.notEnrolled
    })
  })

  it('refuses if ANY named caller is unenrolled, not just the first', () => {
    const store = fakeStore()
    const grant = new OwnerGrant({ store })
    grant.enrol('ws-1', 'good', { kty: 'OKP' })
    expect(grant.exportAgent('ws-1', 'node-1', ['good', 'stranger'])).toEqual({
      ok: false,
      reason: GRANT_REASON.notEnrolled
    })
  })
})

describe('reasons are distinct HERE and indistinguishable on the wire', () => {
  it('tells the owner WHICH refusal it was', () => {
    // The lane's indistinguishability ruling is about the LISTENER, where a
    // stranger could enumerate. There is no stranger on this surface, and an
    // owner told only "no" is left guessing at their own machine.
    const grant = new OwnerGrant({ store: fakeStore() })
    const noCallers = grant.exportAgent('ws-1', 'n', [])
    const notEnrolled = grant.exportAgent('ws-1', 'n', ['stranger'])
    expect(noCallers.reason).not.toBe(notEnrolled.reason)
  })
})

describe('the default cannot widen reach', () => {
  it("defaults visibility to 'identified', never 'public'", () => {
    // S3 ruled a live call is never public, and the store's isExport refuses a
    // public grant. An omitted argument must land on the safe half — a default
    // that widens reach is a hole nobody typed.
    let captured: { visibility?: string } | null = null
    const store = fakeStore({
      exportAgent: ((g: { visibility?: string }) => void (captured = g)) as never
    })
    const grant = new OwnerGrant({ store })
    grant.enrol('ws-1', 'caller-a', { kty: 'OKP' })
    grant.exportAgent('ws-1', 'node-1', ['caller-a'])

    expect(captured).not.toBeNull()
    expect((captured as unknown as { visibility: string }).visibility).toBe('identified')
  })
})
