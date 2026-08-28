import {
  createPublicKey,
  generateKeyPairSync,
  verify,
  type JsonWebKey as NodeJsonWebKey
} from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServedRemoteTranscriptClient } from '../src/main/served-remote-transcript'
import { callAssertionPayload } from '../src/main/call-ceremony'
import type { TurnRecord } from '../src/shared/turn'

const roots: string[] = []
const target = { origin: 'http://crew.test:8639', slug: 'research' }
const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

function keyBase(mode = 0o600): string {
  const base = path.join(tmpdir(), `cookrew-served-remote-${process.pid}-${roots.length}`)
  roots.push(base)
  const dir = path.join(base, 'crew-keys')
  mkdirSync(dir, { recursive: true })
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(
    path.join(dir, 'crew.test_8639-research.json'),
    JSON.stringify({
      pub: pair.publicKey.export({ format: 'jwk' }),
      priv: pair.privateKey.export({ format: 'jwk' })
    }),
    { mode }
  )
  return base
}

const turn = (index: number): TurnRecord => ({
  index,
  prompt: `prompt ${index}`,
  reply: `reply ${index}`,
  startedAt: index * 10,
  endedAt: index * 10 + 5,
  final: true
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ServedRemoteTranscriptClient', () => {
  it.skipIf(process.platform === 'win32')('keeps sign-in private, single-flights it, and preserves a bare full history', async () => {
    const base = keyBase()
    const history = Array.from({ length: 25 }, (_, index) => turn(index + 1))
    let assertions = 0
    let authorizedReads = 0
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/research/crew') return response(200, { serviceId: 'svc-research' })
      if (url.pathname === '/research/api/call/challenge') return response(200, { challenge: 'challenge' })
      if (url.pathname === '/research/api/call/assert') {
        assertions += 1
        const body = JSON.parse(String(init?.body)) as {
          sub: string
          challenge: string
          signature: string
          jwk: NodeJsonWebKey
        }
        const valid = verify(
          null,
          Buffer.from(callAssertionPayload('svc-research', body.sub, body.challenge), 'utf8'),
          createPublicKey({ key: body.jwk, format: 'jwk' }),
          Buffer.from(body.signature, 'base64url')
        )
        expect(valid).toBe(true)
        return response(200, { token: 'opaque' })
      }
      if (init?.headers && (init.headers as Record<string, string>).authorization === 'Bearer opaque') {
        authorizedReads += 1
      }
      if (url.pathname === '/research/turns') return response(200, history)
      if (url.pathname === '/research/trace/index') return response(200, [{ index: 25, title: 'last' }])
      return response(200, [])
    }
    const client = new ServedRemoteTranscriptClient(target, { keyBase: base, fetcher })
    const [page, index] = await Promise.all([client.listTurns({}), client.listTraceIndex()])
    expect(page.turns).toHaveLength(25)
    expect(index).toEqual([{ index: 25, title: 'last' }])
    expect(assertions).toBe(1)
    expect(authorizedReads).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('treats a missing key and a valid caller without a session as empty, not another session', async () => {
    const missingBase = path.join(tmpdir(), `cookrew-served-remote-missing-${process.pid}`)
    roots.push(missingBase)
    let calls = 0
    const missing = new ServedRemoteTranscriptClient(target, {
      keyBase: missingBase,
      fetcher: async () => {
        calls += 1
        return response(500, {})
      }
    })
    expect(await missing.listTurns({})).toEqual({ turns: [], total: 0, offset: 0 })
    expect(calls).toBe(0)

    const base = keyBase()
    const fetcher: typeof fetch = async (input) => {
      const pathname = new URL(String(input)).pathname
      if (pathname === '/research/crew') return response(200, { serviceId: 'svc-research' })
      if (pathname === '/research/api/call/challenge') return response(200, { challenge: 'challenge' })
      if (pathname === '/research/api/call/assert') return response(200, { token: 'opaque' })
      return response(404, {})
    }
    const noSession = new ServedRemoteTranscriptClient(target, { keyBase: base, fetcher })
    expect(await noSession.listTrace({ limit: 1 })).toEqual({ blocks: [], total: 0, source: null })
    expect(await noSession.listTraceIndex()).toEqual([])
  })

  it('refuses a caller key file that is not private', async () => {
    const client = new ServedRemoteTranscriptClient(target, { keyBase: keyBase(0o644) })
    await expect(client.listTurns({})).rejects.toThrow(/permissions are not private/)
  })
})
