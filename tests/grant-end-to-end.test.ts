import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { generateKeyPairSync, sign, type KeyPairKeyObjectResult } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { handleCallRoutes } from '../src/main/call-endpoints'
import { CallCredentialService } from '../src/main/call-credential'
import { callAssertionPayload, makeCallCeremony } from '../src/main/call-ceremony'
import { makeCallGate } from '../src/main/call-gate'
import { AgentExportStore } from '../src/main/agent-export'
import { CallConversationStore } from '../src/main/call-conversation'
import { makeCallSession } from '../src/main/call-session'
import { CallsInFlight } from '../src/main/call-inflight'
import { makeCallRun } from '../src/main/call-run'
import { OwnerGrant } from '../src/main/owner-grant'
import { buildGrantRoster } from '../src/main/grant-roster'
import type { CanvasNode } from '../src/shared/model'

/**
 * GRANT, CALL, REVOKE — the whole lane, once, with nothing stubbed between the
 * owner's decision and the caller's answer.
 *
 * Every other test in this lane pins one seam. This one exists because the
 * question the owner asked is not about a seam: can the owner grant, can a
 * caller call, and does revoke stop it — end to end. A lane whose parts are
 * each proven and which has never been run whole is a lane nobody has checked
 * the JOINS of, and the joins are where a real grant surface fails.
 *
 * Real here: the export store on a real temp dir, the credential issuer and
 * its challenges, the ed25519 ceremony against a real key, the gate, the
 * conversation store, the HTTP endpoints, CallsInFlight, and OwnerGrant. The
 * only stand-in is the pty itself — cutVersion and the ask — because a real
 * one needs a terminal, and what those would add is pinned in call-fork and
 * call-run's own tests.
 */

const WS = 'ws-cookrew-dev'
const SLUG = 'cookrew-dev'
const NODE = 'node-forge'

const terminal = (): CanvasNode =>
  ({ kind: 'terminal', id: NODE, name: 'Forge', preset: 'claude', command: 'claude',
     cwd: '/tmp', orch: false, role: null }) as CanvasNode

interface Captured { status: number; headers: Record<string, string>; body: unknown }

function stubRequest(method: string, authorization?: string, body?: string): http.IncomingMessage {
  const request = Readable.from(body ? [body] : []) as http.IncomingMessage
  request.method = method
  request.headers = authorization ? { authorization } : {}
  return request
}

function stubResponse(): { response: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  const response = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value
      return this
    },
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = { ...captured.headers, ...headers }
      return this
    },
    end(raw?: Buffer | string) {
      captured.body = raw && raw.length ? JSON.parse(raw.toString()) : undefined
    }
  } as unknown as http.ServerResponse
  return { response, captured }
}

let base = ''
let clock = 1_700_000_000_000
let issuer: CallCredentialService
let exports: AgentExportStore
let conversations: CallConversationStore
let flight: CallsInFlight
let owner: OwnerGrant
let buyer: KeyPairKeyObjectResult
let forks = 0
/** Resolves the ask currently in flight, so a revoke can be raced against it. */
let answer: ((text: string) => void) | null = null

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-grant-e2e-'))
  clock = 1_700_000_000_000
  issuer = new CallCredentialService({ base, now: () => clock })
  exports = new AgentExportStore(base)
  conversations = new CallConversationStore(base)
  flight = new CallsInFlight()
  owner = new OwnerGrant({
    store: exports,
    now: () => clock,
    cancelInFlight: (match) => flight.cancelWhere(match)
  })
  buyer = generateKeyPairSync('ed25519')
  forks = 0
  answer = null
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const jwk = (): Record<string, unknown> =>
  buyer.publicKey.export({ format: 'jwk' }) as Record<string, unknown>

/** The caller's half of the ceremony, signed with a real key. */
function credential(sub = 'buyer-1'): string {
  const challenge = issuer.challenge(WS)
  const payload = Buffer.from(callAssertionPayload(WS, sub, challenge), 'utf8')
  const signature = sign(null, payload, buyer.privateKey).toString('base64url')
  const result = makeCallCeremony({
    issuer,
    enrolledKey: (w, s) => exports.enrolledKey(w, s)
  }).assert(WS, { sub, challenge, signature })
  if (!result.ok) throw new Error(`ceremony refused: ${result.reason}`)
  return result.token
}

function deps(): Parameters<typeof handleCallRoutes>[3] {
  return {
    decide: makeCallGate({
      nodesOf: () => [terminal()],
      exportOf: (w, n) => exports.exportOf(w, n),
      enrolled: (w, s) => exports.enrolledKey(w, s) !== null,
      issuer
    }),
    ceremony: makeCallCeremony({
      issuer,
      enrolledKey: (w, s) => exports.enrolledKey(w, s)
    }),
    slugOf: () => SLUG,
    session: makeCallSession({
      conversations,
      cutVersion: (sourceId) => {
        forks += 1
        return {
          forkId: `fork-${sourceId}-${forks}`,
          forkName: `Forge ⑂T${forks}`,
          pin: { version: forks, atIndex: 7, scrollLine: 100, cutAt: clock }
        }
      },
      forkAlive: () => true,
      now: () => clock
    }),
    run: makeCallRun({
      sessionOf: () => ({ pty: true }),
      ready: () => Promise.resolve(),
      // The pty stand-in: it parks until the test answers it, which is what
      // makes "revoke a call ALREADY RUNNING" a thing this test can stage.
      ask: (_session, prompt, signal) =>
        new Promise<string>((resolve) => {
          answer = (text) => resolve(text ?? `answer to: ${prompt}`)
          signal?.addEventListener('abort', () => { answer = null })
        }),
      inFlight: (identity, cancel) => flight.enter(identity, cancel),
      wait: () => new Promise(() => undefined)
    })
  }
}

function ask(token?: string): Promise<Captured> {
  const { response, captured } = stubResponse()
  return handleCallRoutes(
    stubRequest('POST', token ? `Bearer ${token}` : undefined, JSON.stringify({ text: 'are you there?' })),
    response,
    new URL(`/agents/forge/ask`, 'https://owner.example'),
    deps(),
    WS
  ).then(() => captured)
}

/** Let the parked ask register before the owner acts on it. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('the owner grants, a caller calls, the owner revokes — end to end', () => {
  it('BEFORE the grant, a caller with a real key cannot even get a credential', () => {
    // Nothing has been granted, so the ceremony has no key to check against.
    // This is the closed default doing its job at the very first step.
    expect(() => credential()).toThrow(/ceremony refused/)
  })

  it('BEFORE the export, an enrolled caller is refused the agent — as 404', async () => {
    expect(owner.enrol(WS, 'buyer-1', jwk())).toEqual({ ok: true })
    const captured = await ask(credential())
    // Enrolment buys a credential for the WORKSPACE; it does not buy an AGENT.
    // Two separate grants, and this is what that separation is worth.
    //
    // 404 rather than 403, and it is worth being precise about why: a scoped
    // URL must not confirm what exists outside its scope. An agent nobody
    // exported and a name that resolves to nothing are ONE answer, so a caller
    // holding a valid workspace credential still cannot enumerate the room.
    expect(captured.status).toBe(404)
  })

  it('THE OWNER GRANTS, and the call is served', async () => {
    owner.enrol(WS, 'buyer-1', jwk())
    expect(owner.exportAgent(WS, NODE, ['buyer-1'])).toEqual({ ok: true })

    const pending = ask(credential())
    await settle()
    answer?.('I am here.')

    const captured = await pending
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ reply: 'I am here.', agent: 'forge' })
  })

  it('THE OWNER REVOKES A CALL ALREADY RUNNING — and the reply never lands', async () => {
    owner.enrol(WS, 'buyer-1', jwk())
    owner.exportAgent(WS, NODE, ['buyer-1'])

    const pending = ask(credential())
    await settle()

    // The call is genuinely in flight and the owner can SEE it — which is what
    // makes the control usable rather than a leap of faith.
    const roster = buildGrantRoster({
      workspaceId: WS,
      enrolledIn: (w) => exports.enrolledIn(w),
      exportsIn: (w) => exports.exportsIn(w),
      callsIn: (w) => flight.listIn(w)
    })
    expect(roster.live).toEqual([{ sub: 'buyer-1', nodeId: NODE }])
    expect(roster.agents[0].inFlight).toBe(1)

    const result = owner.revoke(WS, 'buyer-1')
    expect(result).toEqual({ ok: true, stopped: 1 })

    // The agent answers anyway, a beat too late. It must go nowhere.
    answer?.('the thing the owner changed their mind about')

    const captured = await pending
    expect(captured.status).toBe(403)
    expect(captured.body).toEqual({ reason: 'revoked' })
  })

  it('AFTER the revoke, the caller cannot get back in with the same key', async () => {
    owner.enrol(WS, 'buyer-1', jwk())
    owner.exportAgent(WS, NODE, ['buyer-1'])
    const token = credential()
    owner.revoke(WS, 'buyer-1')

    // THE HOLE THIS TEST FOUND. The credential it already holds is not
    // expired — tokens live an hour — and entitlement used to read only the
    // export's caller list, which a revoke does not touch. So a revoked caller
    // kept being served for the rest of that hour, and cutting the call in
    // flight made it worse rather than better: the running call stopped and
    // the next one was answered. Entitlement now AND-s both grants, read live
    // at the call, so the token is worth nothing the instant the record says
    // so. Nothing parks here — a refusal never reaches the ask.
    const withOldToken = await ask(token)
    expect(withOldToken.status).toBe(403)
    expect(withOldToken.body).toEqual({ reason: 'entitlement' })

    // And a fresh ceremony cannot start: the enrolment is gone.
    expect(() => credential()).toThrow(/ceremony refused/)
  })

  it('UNEXPORT stops every caller of that agent, not just one', async () => {
    owner.enrol(WS, 'buyer-1', jwk())
    owner.enrol(WS, 'buyer-2', jwk())
    owner.exportAgent(WS, NODE, ['buyer-1', 'buyer-2'])

    const first = ask(credential('buyer-1'))
    await settle()
    const firstAnswer = answer
    const second = ask(credential('buyer-2'))
    await settle()

    expect(flight.listIn(WS)).toHaveLength(2)
    expect(owner.unexport(WS, NODE)).toEqual({ ok: true, stopped: 2 })

    firstAnswer?.('too late')
    answer?.('also too late')

    expect((await first).status).toBe(403)
    expect((await second).status).toBe(403)
    // The address stops existing rather than refusing: an unexported agent and
    // a name that never resolved are one answer, so nobody can map the room.
    expect((await ask(credential('buyer-1'))).status).toBe(404)
  })

  it('the workspace can drain afterwards — a cut call releases its hold', async () => {
    owner.enrol(WS, 'buyer-1', jwk())
    owner.exportAgent(WS, NODE, ['buyer-1'])

    const pending = ask(credential())
    await settle()
    owner.revoke(WS, 'buyer-1')
    await pending

    // Liveness fact 3 is false again. A revoke that leaked the hold would pin
    // the workspace resident forever, which is the failure mode the counter
    // was built to make impossible.
    expect(flight.count(WS)).toBe(0)
    expect(flight.listIn(WS)).toEqual([])
  })

  it('one caller revoked does not stop another caller mid-call', async () => {
    owner.enrol(WS, 'buyer-1', jwk())
    owner.enrol(WS, 'buyer-2', jwk())
    owner.exportAgent(WS, NODE, ['buyer-1', 'buyer-2'])

    const innocent = ask(credential('buyer-2'))
    await settle()
    const innocentAnswer = answer

    expect(owner.revoke(WS, 'buyer-1')).toEqual({ ok: true, stopped: 0 })

    innocentAnswer?.('still here')
    expect((await innocent).status).toBe(200)
  })
})
