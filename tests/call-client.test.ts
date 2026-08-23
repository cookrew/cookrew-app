import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CallClient,
  assertionPayload,
  challengeFromHeader,
  outcomeOf,
  type CallFetch,
  type RemoteCrew
} from '../src/shared/call-client'
import { callAssertionPayload } from '../src/main/call-ceremony'

/**
 * THE CALLER'S HALF, tested against the SERVER'S OWN definitions.
 *
 * The client is only correct if it signs the bytes the owner's ceremony
 * verifies, so the payload test imports callAssertionPayload from the serving
 * side rather than restating the format. A client with its own idea of the
 * payload passes its own tests forever and fails every real call — the exact
 * shape of guard this program keeps finding, and one a self-contained test
 * cannot see.
 */

const CREW: RemoteCrew = {
  host: 'https://box.example:8643',
  slug: 'cookrew-dev',
  workspaceId: 'ws-cookrew-dev',
  sub: 'kestrel'
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function stubFetch(
  answers: (call: Call) => { status: number; body?: unknown; challenge?: string }
): { fetch: CallFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: CallFetch = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body }
    calls.push(call)
    const answer = answers(call)
    return {
      status: answer.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'www-authenticate' && answer.challenge
            ? `Cookrew realm="cookrew-dev", challenge=${answer.challenge}`
            : null
      },
      text: async () => JSON.stringify(answer.body ?? {})
    }
  }
  return { fetch, calls }
}

/** A real ed25519 signature, so the payload is genuinely signable. */
const keys = generateKeyPairSync('ed25519')
const signer = (payload: string): string =>
  sign(null, Buffer.from(payload, 'utf8'), keys.privateKey).toString('base64url')

const client = (fetch: CallFetch): CallClient =>
  new CallClient(CREW, { fetch, sign: signer })

describe('the assertion payload matches the server that verifies it', () => {
  it('is byte-identical to callAssertionPayload', () => {
    // The one test that cannot be written self-referentially. A client with its
    // own idea of this string passes its own suite and fails every real call.
    expect(assertionPayload('ws-1', 'kestrel', 'nonce-abc')).toBe(
      callAssertionPayload('ws-1', 'kestrel', 'nonce-abc')
    )
  })

  it('signs over the WORKSPACE ID, which is not on the wire', () => {
    // The finding this client exists to close: only the slug and the challenge
    // are obtainable from the wire, so a caller given a URL alone cannot
    // complete the ceremony however correct its crypto is.
    expect(assertionPayload('ws-1', 'k', 'n')).toContain('ws-1')
    expect(assertionPayload('ws-1', 'k', 'n')).not.toContain('cookrew-dev')
  })
})

describe('reading the challenge off a 401', () => {
  it('takes the nonce out of the header the spec names', () => {
    expect(challengeFromHeader('Cookrew realm="cookrew-dev", challenge=abc_123-XY')).toBe(
      'abc_123-XY'
    )
  })

  it('answers null rather than guessing when there is no challenge', () => {
    expect(challengeFromHeader(null)).toBeNull()
    expect(challengeFromHeader('Basic realm="x"')).toBeNull()
  })
})

describe('five wire answers, three things a caller can do', () => {
  it('409 is the ONLY retryable refusal', () => {
    expect(outcomeOf(409, 'busy')).toBe('wait')
    expect(outcomeOf(409, 'not_ready')).toBe('wait')
    expect(outcomeOf(409, 'not_running')).toBe('wait')
  })

  it('401, 403 and 404 all mean stop — a retried 403 is a loop', () => {
    for (const status of [401, 403, 404]) expect(outcomeOf(status)).toBe('denied')
  })

  it('404 carries no elaboration, so the room cannot be mapped', () => {
    // An unexported agent and a name that never existed are ONE answer.
    expect(outcomeOf(404)).toBe(outcomeOf(404, 'anything'))
  })

  it('a server fault is ours, not theirs', () => {
    expect(outcomeOf(500)).toBe('broken')
    expect(outcomeOf(503)).toBe('broken')
  })
})

describe('the ceremony, then the call', () => {
  it('gets a challenge, asserts, and calls with the token', async () => {
    const { fetch, calls } = stubFetch((call) => {
      if (call.url.endsWith('/api/call/challenge')) {
        return { status: 200, body: { challenge: 'nonce-1' } }
      }
      if (call.url.endsWith('/api/call/assert')) return { status: 200, body: { token: 'tok-1' } }
      return { status: 200, body: { reply: 'I am here.', conversation: 'c1', version: 3 } }
    })

    const outcome = await client(fetch).ask('forge', 'are you there?')

    expect(outcome).toMatchObject({
      kind: 'ok',
      text: 'I am here.',
      conversation: 'c1',
      version: 3
    })
    // Signed the right bytes, with the workspace id and the served nonce.
    const asserted = JSON.parse(calls[1].body as string)
    expect(asserted.sub).toBe('kestrel')
    expect(asserted.challenge).toBe('nonce-1')
    expect(asserted.signature).toBe(signer(assertionPayload('ws-cookrew-dev', 'kestrel', 'nonce-1')))
    // And carried the credential on the ask.
    expect(calls[2].headers.authorization).toBe('Bearer tok-1')
    expect(calls[2].url).toBe('https://box.example:8643/cookrew-dev/agents/forge/ask')
  })

  it('carries the conversation so a second ask does not cut a new version', async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.includes('/api/call/')
        ? { status: 200, body: { challenge: 'n', token: 't' } }
        : { status: 200, body: { reply: 'ok', conversation: 'c1' } }
    )
    const c = client(fetch)
    const first = await c.ask('forge', 'one')
    await c.ask('forge', 'two', first.conversation)
    expect(JSON.parse(calls[calls.length - 1].body as string).conversation).toBe('c1')
  })

  it('re-ceremonies ONCE on a 401, and does not loop on a second', async () => {
    // Tokens live an hour, so a long conversation outlives one. But a fresh
    // token that is also refused means this caller may not call, and retrying
    // is precisely the loop 403 exists to prevent.
    let asks = 0
    const { fetch, calls } = stubFetch((call) => {
      if (call.url.includes('/api/call/')) {
        return { status: 200, body: { challenge: 'n', token: 't' } }
      }
      asks += 1
      return { status: 401, body: {} }
    })

    const outcome = await client(fetch).ask('forge', 'hello')

    expect(outcome.kind).toBe('denied')
    expect(asks, 'exactly two asks: the original and one retry').toBe(2)
    expect(calls.filter((c) => c.url.endsWith('/assert'))).toHaveLength(2)
  })

  it('a ceremony that cannot complete is denied, not retried forever', async () => {
    const { fetch } = stubFetch((call) =>
      call.url.endsWith('/api/call/challenge') ? { status: 500 } : { status: 200 }
    )
    expect(await client(fetch).ask('forge', 'hi')).toMatchObject({ kind: 'denied' })
  })

  it('a revoked caller is DENIED and its reason survives for the card to word', async () => {
    const { fetch } = stubFetch((call) =>
      call.url.includes('/api/call/')
        ? { status: 200, body: { challenge: 'n', token: 't' } }
        : { status: 403, body: { reason: 'revoked' } }
    )
    expect(await client(fetch).ask('forge', 'hi')).toMatchObject({
      kind: 'denied',
      reason: 'revoked'
    })
  })

  it('a busy agent is WAIT, and says so distinctly from denied', async () => {
    const { fetch } = stubFetch((call) =>
      call.url.includes('/api/call/')
        ? { status: 200, body: { challenge: 'n', token: 't' } }
        : { status: 409, body: { reason: 'not_ready' } }
    )
    expect(await client(fetch).ask('forge', 'hi')).toMatchObject({
      kind: 'wait',
      reason: 'not_ready'
    })
  })

  it('forget() drops the credential, so a revoke does not leave a stale token', async () => {
    let ceremonies = 0
    const { fetch } = stubFetch((call) => {
      if (call.url.endsWith('/api/call/assert')) {
        ceremonies += 1
        return { status: 200, body: { token: `t${ceremonies}` } }
      }
      if (call.url.endsWith('/api/call/challenge')) return { status: 200, body: { challenge: 'n' } }
      return { status: 200, body: { reply: 'ok' } }
    })
    const c = client(fetch)
    await c.ask('forge', 'one')
    await c.ask('forge', 'two')
    expect(ceremonies, 'the held token is reused').toBe(1)
    c.forget()
    await c.ask('forge', 'three')
    expect(ceremonies).toBe(2)
  })

  it('percent-encodes the agent name rather than building a path by hand', async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.includes('/api/call/')
        ? { status: 200, body: { challenge: 'n', token: 't' } }
        : { status: 200, body: { reply: 'ok' } }
    )
    await client(fetch).ask('forge/../admin', 'hi')
    expect(calls[2].url).toContain('forge%2F..%2Fadmin')
  })
})
