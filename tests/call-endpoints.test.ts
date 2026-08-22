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
import type { CanvasNode } from '../src/shared/model'

/**
 * THE HTTP SURFACE (④ · S2) — the gate's answers, rendered.
 *
 * Two things are being pinned here. The status codes ARE the protocol, so each
 * refusal is checked for its exact shape and for what it does NOT say. And the
 * gate is independent: a pairing token — the LAN tier's credential — buys
 * nothing on this route, because tiers are distinguished by the credential
 * presented and never by the listener the bytes arrived on.
 */

const WS = 'ws-cookrew-dev'
const SLUG = 'cookrew-dev'

const terminal = (id: string, name: string): CanvasNode =>
  ({ kind: 'terminal', id, name, preset: 'claude', command: 'claude', cwd: '/tmp',
     orch: false, role: null }) as CanvasNode

interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

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
let forks = 0
let caller: KeyPairKeyObjectResult

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-call-http-'))
  clock = 1_700_000_000_000
  issuer = new CallCredentialService({ base, now: () => clock })
  exports = new AgentExportStore(base)
  conversations = new CallConversationStore(base)
  forks = 0
  caller = generateKeyPairSync('ed25519')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const deps = (): Parameters<typeof handleCallRoutes>[3] => {
  const ceremony = makeCallCeremony({
    issuer,
    enrolledKey: (workspaceId, sub) => exports.enrolledKey(workspaceId, sub)
  })
  const decide = makeCallGate({
    nodesOf: () => [terminal('node-forge', 'Forge')],
    exportOf: (workspaceId, nodeId) => exports.exportOf(workspaceId, nodeId),
    issuer
  })
  const session = makeCallSession({
    conversations,
    // A stand-in for fork.ts, which needs a real PTY. What matters at this
    // layer is that a version is cut exactly once per conversation, which the
    // counter makes visible; cutCallVersion's own ordering is pinned in
    // tests/call-fork.test.ts against the real pin store.
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
  })
  return { decide, ceremony, slugOf: () => SLUG, session }
}

const call = async (
  method: string,
  pathname: string,
  options: { authorization?: string; body?: string } = {}
): Promise<{ handled: boolean; captured: Captured }> => {
  const { response, captured } = stubResponse()
  const handled = await handleCallRoutes(
    stubRequest(method, options.authorization, options.body),
    response,
    new URL(pathname, 'https://owner.example'),
    deps(),
    WS
  )
  return { handled, captured }
}

const exportForge = (callers: string[] = ['alice']): void => {
  exports.exportAgent({ workspaceId: WS, nodeId: 'node-forge', visibility: 'identified', callers })
}

const enrolAlice = (workspace = WS): void => {
  exports.enrol(
    workspace,
    'alice',
    caller.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  )
}

/**
 * A real credential for `workspace`, obtained the way a caller obtains one.
 *
 * The caller must be enrolled AT that workspace to get one at all — enrolment
 * does not travel, which tests/agent-export.test.ts pins directly. So a
 * credential for ws-playground is a genuine credential from a workspace this
 * caller is genuinely enrolled at; presenting it here is the D4/R9 case, not a
 * forgery.
 */
const credentialFor = (workspace = WS): string => {
  enrolAlice(workspace)
  const challenge = issuer.challenge(workspace)
  const payload = Buffer.from(callAssertionPayload(workspace, 'alice', challenge), 'utf8')
  const signature = sign(null, payload, caller.privateKey).toString('base64url')
  const result = makeCallCeremony({
    issuer,
    enrolledKey: (w, s) => exports.enrolledKey(w, s)
  }).assert(workspace, { sub: 'alice', challenge, signature })
  if (!result.ok) throw new Error(`ceremony failed: ${result.reason}`)
  return result.token
}

describe('the call route — what each refusal says, and what it does not', () => {
  it('401s with a challenge in the header the spec names', async () => {
    exportForge()
    const { handled, captured } = await call('POST', '/agents/forge/ask')
    expect(handled).toBe(true)
    expect(captured.status).toBe(401)
    expect(captured.headers['www-authenticate']).toMatch(
      new RegExp(`^Cookrew realm="${SLUG}", challenge=[A-Za-z0-9_-]+$`)
    )
    expect(captured.body).toEqual({})
  })

  it('hands out a challenge that is actually spendable', async () => {
    exportForge()
    enrolAlice()
    const { captured } = await call('POST', '/agents/forge/ask')
    const challenge = String(captured.headers['www-authenticate']).split('challenge=')[1]
    const payload = Buffer.from(callAssertionPayload(WS, 'alice', challenge), 'utf8')
    const signature = sign(null, payload, caller.privateKey).toString('base64url')
    const asserted = await call('POST', '/api/call/assert', {
      body: JSON.stringify({ sub: 'alice', challenge, signature })
    })
    expect(asserted.captured.status).toBe(200)
    expect(typeof (asserted.captured.body as { token: string }).token).toBe('string')
  })

  it('403s with a reason word, not a sentence', async () => {
    exportForge(['bob'])
    const { captured } = await call('POST', '/agents/forge/ask', {
      authorization: `Bearer ${credentialFor()}`
    })
    expect(captured.status).toBe(403)
    expect(captured.body).toEqual({ reason: 'entitlement' })
  })

  it('403s a credential minted for another workspace', async () => {
    exportForge()
    const { captured } = await call('POST', '/agents/forge/ask', {
      authorization: `Bearer ${credentialFor('ws-playground')}`
    })
    expect(captured.status).toBe(403)
    expect(captured.body).toEqual({ reason: 'workspace' })
  })

  it('404s an unexported agent with an EMPTY body', async () => {
    const { captured } = await call('POST', '/agents/forge/ask')
    expect(captured.status).toBe(404)
    // Nothing to read: no name, no id, no explanation of what is missing.
    expect(captured.body).toEqual({})
  })

  it('501s — not 200 — when the gate says yes and no turn exists yet', async () => {
    exportForge()
    const { captured } = await call('POST', '/agents/forge/ask', {
      authorization: `Bearer ${credentialFor()}`
    })
    // A 200 here would be a call that answered without running, and the caller
    // could not tell an empty reply from a finished one. S3/S4 make it a 200.
    expect(captured.status).toBe(501)
    // Everything but the reply is already real: the version was cut, the fork
    // exists, and the conversation is named. S4 replaces the reason with a
    // reply and the code with 200.
    expect(captured.body).toEqual({
      reason: 'turn_not_implemented',
      agent: 'forge',
      conversation: 'default',
      version: 1,
      fork: 'fork-node-forge-1'
    })
  })

  it('refuses to record a public export at all — a live call is never public', () => {
    // The gate HAS a public branch and the registry uses it: free download is
    // discovery. A call is not. With no subject there is nothing to key a
    // conversation on, so anonymous callers would share one fork's transcript.
    expect(() =>
      exports.exportAgent({
        workspaceId: WS,
        nodeId: 'node-forge',
        visibility: 'public',
        callers: []
      })
    ).toThrow(/never public/)
  })
})

describe('a served call cuts its version, once per conversation', () => {
  it('reuses the conversation across turns rather than forking per request', async () => {
    exportForge()
    const token = credentialFor()
    const first = await call('POST', '/agents/forge/ask', { authorization: `Bearer ${token}` })
    const second = await call('POST', '/agents/forge/ask', { authorization: `Bearer ${token}` })
    expect((first.captured.body as { fork: string }).fork).toBe(
      (second.captured.body as { fork: string }).fork
    )
    expect((second.captured.body as { version: number }).version).toBe(1)
    expect(forks).toBe(1)
  })

  it('runs two named conversations for one caller in parallel', async () => {
    exportForge()
    const token = credentialFor()
    const one = await call('POST', '/agents/forge/ask', {
      authorization: `Bearer ${token}`,
      body: JSON.stringify({ conversation: 'one' })
    })
    const two = await call('POST', '/agents/forge/ask', {
      authorization: `Bearer ${token}`,
      body: JSON.stringify({ conversation: 'two' })
    })
    expect((one.captured.body as { fork: string }).fork).not.toBe(
      (two.captured.body as { fork: string }).fork
    )
    expect(forks).toBe(2)
  })

  it('403s a conversation id that is not a key', async () => {
    exportForge()
    const { captured } = await call('POST', '/agents/forge/ask', {
      authorization: `Bearer ${credentialFor()}`,
      body: JSON.stringify({ conversation: '../escape' })
    })
    expect(captured.status).toBe(403)
    expect(captured.body).toEqual({ reason: 'conversation' })
    expect(forks).toBe(0)
  })

  it('409s when there is no transcript to cut a version from', async () => {
    exportForge()
    const { response, captured } = stubResponse()
    const failing = { ...deps(), session: () => { throw new Error('no completed turns to cut a version from') } }
    await handleCallRoutes(
      stubRequest('POST', `Bearer ${credentialFor()}`),
      response,
      new URL('/agents/forge/ask', 'https://owner.example'),
      failing,
      WS
    )
    // Not 501: that would claim the gate is fine and only the turn is missing,
    // when in fact the call could not produce a version at all.
    expect(captured.status).toBe(409)
    expect((captured.body as { reason: string }).reason).toBe('no_version')
  })

  it('never cuts a version for a call the gate refused', async () => {
    exportForge(['bob'])
    await call('POST', '/agents/forge/ask', { authorization: `Bearer ${credentialFor()}` })
    await call('POST', '/agents/forge/ask')
    expect(forks).toBe(0)
  })
})

describe('the call route is independent of the pairing gate', () => {
  it('does not accept a pairing token as a call credential', async () => {
    exportForge()
    // The LAN tier's credential, presented exactly as a phone presents it.
    // Tiers are told apart by the credential, never by the listener — and this
    // one is not a call credential, so it buys a 401 like any other stranger.
    const { captured } = await call('POST', '/agents/forge/ask', {
      authorization: 'Bearer pairing-token-123'
    })
    expect(captured.status).toBe(401)
  })

  it('answers a missing credential and a junk one identically', async () => {
    exportForge()
    const missing = await call('POST', '/agents/forge/ask')
    const junk = await call('POST', '/agents/forge/ask', { authorization: 'Bearer nonsense' })
    expect(junk.captured.status).toBe(missing.captured.status)
    expect(junk.captured.body).toEqual(missing.captured.body)
  })

  it('treats an empty bearer as no credential, never as a match', async () => {
    exportForge()
    const { captured } = await call('POST', '/agents/forge/ask', { authorization: 'Bearer   ' })
    expect(captured.status).toBe(401)
  })
})

describe('the ceremony over HTTP', () => {
  it('issues a challenge to anyone, because a nonce grants nothing', async () => {
    const { captured } = await call('POST', '/api/call/challenge')
    expect(captured.status).toBe(200)
    expect(typeof (captured.body as { challenge: string }).challenge).toBe('string')
  })

  it('gives the same 401 for every way an assertion fails', async () => {
    enrolAlice()
    const challenge = issuer.challenge(WS)
    const unknownCaller = await call('POST', '/api/call/assert', {
      body: JSON.stringify({ sub: 'mallory', challenge, signature: 'x' })
    })
    const badSignature = await call('POST', '/api/call/assert', {
      body: JSON.stringify({ sub: 'alice', challenge: issuer.challenge(WS), signature: 'x' })
    })
    const malformed = await call('POST', '/api/call/assert', { body: '{}' })
    // An enrolment oracle would let a stranger enumerate who may call this
    // workspace. All three are one answer with nothing in the body.
    for (const attempt of [unknownCaller, badSignature, malformed]) {
      expect(attempt.captured.status).toBe(401)
      expect(attempt.captured.body).toEqual({})
    }
  })
})

describe('what this handler declines to answer', () => {
  it('does not handle a GET of the call address', async () => {
    const { handled } = await call('GET', '/agents/forge/ask')
    expect(handled).toBe(false)
  })

  it('does not handle anything else, so the rest of the server still runs', async () => {
    for (const pathname of ['/api/state', '/api/workspace', '/agents/forge', '/']) {
      expect((await call('POST', pathname)).handled).toBe(false)
    }
  })
})
