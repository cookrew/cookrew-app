// THE PHONE'S END OF THE SEALED SESSION (path/seal-client.ts), against the real terminus
// over real HTTP.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeDialer } from '../src/main/canvas-bridge'
import { createSealTerminus, type SealTerminus, type SealTerminusDeps } from '../src/main/canvas-seal-terminus'
import { openSeal, SEAL_VERSION_PATH, SealDowngradedError, SealRefusedError, type SealClient } from '../src/renderer/src/path/seal-client'
import { connectCodeId, newConnectCode, proveReplaced, replacedKeyOf, startHandshake } from '../src/shared/canvas-seal'

const encoded = (code: Uint8Array): string => Buffer.from(code).toString('base64url')

/** Answers with what it was asked. */
const echo: BridgeDialer = (input, onResponse) => {
  const parts: Buffer[] = []
  return {
    write: (body) => void parts.push(Buffer.from(body)),
    end: () =>
      onResponse({
        status: input.path === '/missing' ? 404 : 200,
        headers: { 'content-type': 'application/json' },
        onData: (listener) => listener(Buffer.from(JSON.stringify({ method: input.method, path: input.path, auth: input.headers.authorization ?? null, body: Buffer.concat(parts).toString() }))),
        onEnd: (listener) => setImmediate(listener),
        pause: () => undefined,
        resume: () => undefined
      }),
    destroy: () => undefined
  }
}

const servers: Server[] = []
const clients: SealClient[] = []
const terminuses: SealTerminus[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const terminus of terminuses.splice(0)) terminus.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function bed(deps: Partial<SealTerminusDeps> = {}, before?: (path: string) => number | null) {
  const code = newConnectCode()
  const id = await connectCodeId(code)
  const terminus = createSealTerminus({ codeFor: (asked) => (asked === id ? code : null), dial: echo, ...deps })
  terminuses.push(terminus)
  const server = createServer((request, response) => {
    const held = before?.(request.url ?? '')
    if (held) {
      response.writeHead(held)
      response.end()
      return
    }
    void terminus.handle(request, response, { device: 'phone', deviceName: 'Phone' })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { code, terminus, url: (path: string): string => `${origin}${path}` }
}

const open = async (url: (path: string) => string, code: Uint8Array, retryMs = 5): Promise<SealClient> => {
  const client = await openSeal({ url, code: encoded(code), retryMs })
  clients.push(client)
  return client
}

const text = (body: Uint8Array): string => Buffer.from(body).toString()

describe('openSeal', () => {
  it('carries a request and brings back its answer', async () => {
    const { url, code } = await bed()
    const client = await open(url, code)
    const answer = await client.request({ method: 'POST', path: '/api/x', headers: { authorization: 'Bearer t' }, body: '{"sealed":"s"}' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(text(answer.body))).toEqual({ method: 'POST', path: '/api/x', auth: 'Bearer t', body: '{"sealed":"s"}' })
  })

  it('keeps requests apart, and passes a refusal on as an answer', async () => {
    const { url, code } = await bed()
    const client = await open(url, code)
    const [a, b, c] = await Promise.all([
      client.request({ method: 'GET', path: '/a', headers: {} }),
      client.request({ method: 'GET', path: '/missing', headers: {} }),
      client.request({ method: 'GET', path: '/c', headers: {} })
    ])
    expect(JSON.parse(text(a.body)).path).toBe('/a')
    expect(b.status).toBe(404)
    expect(JSON.parse(text(c.body)).path).toBe('/c')
  })

  it('a code the Mac does not hold is refused by name, so the page can ask for a new one', async () => {
    const { url } = await bed()
    await expect(open(url, newConnectCode())).rejects.toBeInstanceOf(SealRefusedError)
  })

  it('a code the Mac replaced is refused by that name, when the Mac proves it', async () => {
    const old = newConnectCode()
    const oldId = await connectCodeId(old)
    const key = await replacedKeyOf(old)
    const { url } = await bed({ replacedKeyFor: (asked) => (asked === oldId ? key : null) })
    const refused = await open(url, old).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(SealRefusedError)
    expect((refused as SealRefusedError).why).toBe('replaced')
    expect((refused as SealRefusedError).message).toMatch(/changed/)
    // A relay that only SAYS so is not believed: it is the ordinary refusal.
    const lying = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      String(input).endsWith('/~seal/hello') ? new Response(JSON.stringify({ error: 'code replaced', replaced: 'AAAA' }), { status: 403 }) : fetch(input, init)
    const plain = await openSeal({ url, code: encoded(old), fetchFn: lying }).catch((error: unknown) => error)
    expect((plain as SealRefusedError).why).toBe('code')
    // Nor one that plays back a REAL proof, made for another hello of the same old code.
    const earlier = await startHandshake(old)
    const real = await proveReplaced(key, earlier.hello)
    const replaying = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      String(input).endsWith('/~seal/hello') ? new Response(JSON.stringify({ error: 'code replaced', replaced: real }), { status: 403 }) : fetch(input, init)
    const replayed = await openSeal({ url, code: encoded(old), fetchFn: replaying }).catch((error: unknown) => error)
    expect((replayed as SealRefusedError).why).toBe('code')
  })

  it('an answer that cannot prove the code is refused too: nothing is sent to it', async () => {
    const { url, code } = await bed()
    const wrong = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const answer = await fetch(input, init)
      if (!String(input).endsWith('/~seal/hello')) return answer
      const body = (await answer.json()) as { session: string; accept: { e: string; proof: string } }
      return new Response(JSON.stringify({ ...body, accept: { ...body.accept, proof: 'AAAA' } }), { status: 200 })
    }
    await expect(openSeal({ url, code: encoded(code), fetchFn: wrong })).rejects.toBeInstanceOf(SealRefusedError)
  })

  it('waits out a full line: the down stream answers 503, and then it opens', async () => {
    let refused = 0
    const { url, code } = await bed({}, (path) => (path.startsWith('/~seal/down') && (refused += 1) <= 2 ? 503 : null))
    const client = await open(url, code)
    expect((await client.request({ method: 'GET', path: '/a', headers: {} })).status).toBe(200)
    expect(refused).toBeGreaterThan(2)
  })

  it('a session that ends fails what is waiting, and says so', async () => {
    const stuck: BridgeDialer = () => ({ write: () => undefined, end: () => undefined, destroy: () => undefined })
    const { url, code, terminus } = await bed({ dial: stuck })
    const client = await open(url, code)
    const waiting = client.request({ method: 'GET', path: '/a', headers: {} })
    await new Promise((resolve) => setTimeout(resolve, 30))
    terminus.endSessions('the pairing was rotated')
    await expect(waiting).rejects.toThrow()
  })

  it('gives up on an answer that never comes', async () => {
    const stuck: BridgeDialer = () => ({ write: () => undefined, end: () => undefined, destroy: () => undefined })
    const { url, code } = await bed({ dial: stuck })
    const client = await openSeal({ url, code: encoded(code), requestMs: 40 })
    clients.push(client)
    await expect(client.request({ method: 'GET', path: '/a', headers: {} })).rejects.toThrow(/answer/)
  })

  it('a lost POST ends the session rather than wedging it: records after a gap are never read', async () => {
    const { url, code } = await bed()
    let drop = false
    const flaky = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (drop && String(input).includes('/~seal/up')) return new Response(null, { status: 503 })
      return fetch(input, init)
    }
    const client = await openSeal({ url, code: encoded(code), fetchFn: flaky, retryMs: 5 })
    clients.push(client)
    drop = true
    await expect(client.request({ method: 'GET', path: '/a', headers: {} })).rejects.toThrow(/ended|line/)
    await expect(client.request({ method: 'GET', path: '/b', headers: {} })).rejects.toThrow(/ended/)
  })

  it('a POST that hangs ends the session too', async () => {
    const { url, code } = await bed()
    let hang = false
    const stalled = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!hang || !String(input).includes('/~seal/up')) return fetch(input, init)
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const client = await openSeal({ url, code: encoded(code), fetchFn: stalled, retryMs: 5, upMs: 30 })
    clients.push(client)
    hang = true
    await expect(client.request({ method: 'GET', path: '/a', headers: {} })).rejects.toThrow()
  })

  it('a forged record on the down line ends the session', async () => {
    const { url, code } = await bed()
    const tampered = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const answer = await fetch(input, init)
      if (!String(input).includes('/~seal/down') || !answer.body) return answer
      const reader = answer.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) return controller.close()
          const spoiled = value.slice()
          spoiled[spoiled.length - 1] ^= 0xff
          controller.enqueue(spoiled)
        }
      })
      return new Response(body, { status: answer.status })
    }
    const client = await openSeal({ url, code: encoded(code), fetchFn: tampered, retryMs: 5 })
    clients.push(client)
    await expect(client.request({ method: 'GET', path: '/a', headers: {} })).rejects.toThrow(/ended|forged|tampered/i)
  })

  it('needs nothing newer than the browsers X25519 runs on', async () => {
    const { url, code } = await bed()
    const any = AbortSignal.any
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
    try {
      const client = await open(url, code)
      expect((await client.request({ method: 'GET', path: '/a', headers: {} })).status).toBe(200)
    } finally {
      Object.defineProperty(AbortSignal, 'any', { value: any, configurable: true })
    }
  })

  it('a finish that fails for its own reasons is not called a bad code', async () => {
    const { url, code } = await bed({}, (path) => (path.startsWith('/~seal/finish') ? 502 : null))
    const failed = await open(url, code).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).not.toBeInstanceOf(SealRefusedError)
  })

  it('close fails what is waiting and stops listening', async () => {
    const stuck: BridgeDialer = () => ({ write: () => undefined, end: () => undefined, destroy: () => undefined })
    const { url, code, terminus } = await bed({ dial: stuck })
    const client = await open(url, code)
    const waiting = client.request({ method: 'GET', path: '/a', headers: {} })
    client.close()
    await expect(waiting).rejects.toThrow()
    await expect(client.request({ method: 'GET', path: '/b', headers: {} })).rejects.toThrow()
    // The held line lets go as soon as the server sees the client hang up: waited for, not a fixed 30 ms (a slow
    // Windows runner took longer).
    await vi.waitFor(() => expect(terminus.stats().listening).toBe(0), { timeout: 3000 })
  })
})

describe('openSeal across versions', () => {
  /** A Mac from before v2 reads only v1's fields: what reaches it is the hello without its offer. */
  const asOldMac = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!String(input).endsWith('/~seal/hello') || typeof init?.body !== 'string') return fetch(input, init)
    const { vs: _offer, ...v1 } = JSON.parse(init.body) as Record<string, unknown>
    return fetch(input, { ...init, body: JSON.stringify(v1) })
  }

  const pinned = (start: boolean) => {
    let v2 = start
    return { v2: () => v2, sawV2: () => void (v2 = true), held: () => v2 }
  }

  it('speaks v2 to a Mac that does, and remembers it', async () => {
    const { url, code } = await bed()
    const pin = pinned(false)
    const client = await openSeal({ url, code: encoded(code), retryMs: 5, pin })
    clients.push(client)
    expect(pin.held()).toBe(true)
    expect(JSON.parse(text((await client.request({ method: 'GET', path: '/v2', headers: {} })).body))).toMatchObject({ path: '/v2' })
  })

  it('still works with a Mac from before v2, sealed on v1, and remembers nothing', async () => {
    const { url, code } = await bed()
    const pin = pinned(false)
    const client = await openSeal({ url, code: encoded(code), retryMs: 5, fetchFn: asOldMac, pin })
    clients.push(client)
    expect(pin.held()).toBe(false)
    const answer = await client.request({ method: 'POST', path: '/v1', headers: { authorization: 'Bearer t' }, body: 'b' })
    expect(JSON.parse(text(answer.body))).toEqual({ method: 'POST', path: '/v1', auth: 'Bearer t', body: 'b' })
  })

  it('once pinned to v2, a v1 answer is refused: no quieter session, and nothing sent', async () => {
    const { url, code } = await bed()
    let asked = 0
    const counting = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/~seal/up')) asked += 1
      return asOldMac(input, init)
    }
    await expect(openSeal({ url, code: encoded(code), retryMs: 5, fetchFn: counting, pin: pinned(true) })).rejects.toMatchObject({ why: 'proof' })
    expect(asked).toBe(0)
  })

  it('a carrier that takes the offer off a v2 Mac\'s hello is caught inside the sealed v1 session: pinned, refused, nothing sent', async () => {
    // A Mac whose companion answers its own seal routes, as the real one does (mobile-server.ts · routeSeal).
    const versioned: BridgeDialer = (input, onResponse) => {
      if (input.path !== SEAL_VERSION_PATH) return echo(input, onResponse, () => undefined)
      return {
        write: () => undefined,
        end: () =>
          onResponse({
            status: 200,
            headers: { 'content-type': 'application/json' },
            onData: (listener) => listener(Buffer.from(JSON.stringify({ versions: [2, 1] }))),
            onEnd: (listener) => setImmediate(listener),
            pause: () => undefined,
            resume: () => undefined
          }),
        destroy: () => undefined
      }
    }
    const { url, code } = await bed({ dial: versioned })
    const pin = pinned(false)
    await expect(openSeal({ url, code: encoded(code), retryMs: 5, fetchFn: asOldMac, pin })).rejects.toBeInstanceOf(SealDowngradedError)
    expect(pin.held()).toBe(true)
  })

  it('the terminus says what it speaks at the version route', async () => {
    const { url } = await bed()
    const answer = await fetch(url(SEAL_VERSION_PATH))
    expect(await answer.json()).toEqual({ versions: [2, 1] })
  })
})
