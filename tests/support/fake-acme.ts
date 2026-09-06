import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { T, askUdp, buildQuery, parseAnswer } from './dns-probe'
import { issueLeaf, spkiFromCsr, type Ca } from './x509-forge'

/**
 * A CERTIFICATE AUTHORITY, IN THE SUITE.
 *
 * RFC 8555's six endpoints over node:http, with a one-off CA (tests/support/
 * x509-forge.ts) behind them. It exists so the whole issuance runs with no
 * network at all — and, more to the point, so the dns-01 proof is a REAL one:
 * this server validates a challenge by querying our own dns-server over UDP,
 * exactly as Let's Encrypt would, and refuses the order when the TXT is
 * absent or wrong.
 *
 * WHAT IT PROVES: our JWS is verifiable by someone else's parser (it checks
 * every signature, converting r‖s back to DER to do so), our nonce handling
 * survives a deliberate badNonce, our dns-01 digest matches the one a CA
 * computes from its own thumbprint of our key, the zone answers the CA's
 * question over the wire, the CSR we forward is well formed, and the chain we
 * store parses and carries the notAfter we report.
 *
 * WHAT IT DOES NOT PROVE: that Let's Encrypt agrees. It never rate-limits, its
 * problem documents are our invention, it validates from one resolver rather
 * than several, it does not do CAA, and its chain is trusted by nothing. The
 * staging directory is the next gate and it is an operator's, not a test's.
 */

export interface FakeAcmeOptions {
  /** The dns-server to validate against — the real one, over real UDP. */
  dnsPort: number
  ca: Ca
  /** Answer the first signed POST with badNonce, to exercise the replay path. */
  badNonceOnce?: boolean
  /** Refuse every challenge whatever DNS says, to drive the failure path. */
  refuseAll?: boolean
  /** Hold the challenge this long, so an order is provably still in flight. */
  challengeDelayMs?: number
  notAfter?: Date
  /**
   * L4 — three ways a CA can misbehave, all of them a body it wrote.
   *
   * `lieIdentifier`: the authorization names a name the order never asked for.
   * `offOriginUrls`: the order's URLs point at another origin (the same server
   *   under a different host, which is off-origin and therefore off-limits).
   * `redirectAuthz`: the authorization answers 302 to somewhere else.
   */
  lieIdentifier?: string
  offOriginUrls?: boolean
  redirectAuthz?: boolean
}

export interface FakeAcme {
  directory: string
  /** How many chains this CA has issued. */
  issued: () => number
  /** Every TXT set the CA actually read, in order. */
  seen: () => string[][]
  close: () => Promise<void>
}

interface Authz {
  id: string
  value: string
  token: string
  status: 'pending' | 'valid' | 'invalid'
}

interface Order {
  id: string
  identifiers: string[]
  authz: string[]
  status: 'pending' | 'ready' | 'valid'
  chain?: string
}

const b64url = (bytes: Buffer): string => bytes.toString('base64url')

/** r‖s back to the DER pair node:crypto wants — the inverse of derToRaw. */
const rawToDer = (raw: Buffer): Buffer => {
  const int = (part: Buffer): Buffer => {
    let at = 0
    while (at < part.length - 1 && part[at] === 0) at += 1
    let value = part.subarray(at)
    if ((value[0] & 0x80) !== 0) value = Buffer.concat([Buffer.from([0]), value])
    return Buffer.concat([Buffer.from([0x02, value.length]), value])
  }
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32))])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

/** RFC 7638, written here a second time so the digest is checked, not echoed. */
const thumbprint = (jwk: { crv: string; kty: string; x: string; y: string }): string =>
  b64url(
    createHash('sha256')
      .update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`, 'utf8')
      .digest()
  )

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    request.on('data', (chunk) => {
      text += String(chunk)
    })
    request.on('end', () => resolve(text))
  })

export async function startFakeAcme(options: FakeAcmeOptions): Promise<FakeAcme> {
  const nonces = new Set<string>()
  const authzs = new Map<string, Authz>()
  const orders = new Map<string, Order>()
  const seen: string[][] = []
  let accountJwk: { crv: string; kty: string; x: string; y: string } | null = null
  let issued = 0
  let badNonceLeft = options.badNonceOnce === true ? 1 : 0
  let base = ''

  const mint = (): string => {
    const nonce = b64url(randomBytes(16))
    nonces.add(nonce)
    return nonce
  }

  const send = (
    response: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {}
  ): void => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': typeof payload === 'string' ? 'application/pem-certificate-chain' : 'application/json',
      'replay-nonce': mint(),
      ...headers
    })
    response.end(text)
  }

  const problem = (response: ServerResponse, status: number, type: string, detail: string): void => {
    response.writeHead(status, { 'content-type': 'application/problem+json', 'replay-nonce': mint() })
    response.end(JSON.stringify({ type, detail }))
  }

  /** Reads a JWS, CHECKING the signature and spending the nonce. */
  const open = (
    raw: string,
    response: ServerResponse
  ): { header: Record<string, string>; payload: Record<string, unknown> } | null => {
    let jws: { protected?: string; payload?: string; signature?: string }
    try {
      jws = JSON.parse(raw)
    } catch {
      problem(response, 400, 'urn:ietf:params:acme:error:malformed', 'not a JWS')
      return null
    }
    if (typeof jws.protected !== 'string' || typeof jws.signature !== 'string') {
      problem(response, 400, 'urn:ietf:params:acme:error:malformed', 'not a JWS')
      return null
    }
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8')) as Record<string, unknown>
    const jwk = (header.jwk as typeof accountJwk) ?? accountJwk
    if (jwk === null || jwk === undefined) {
      problem(response, 400, 'urn:ietf:params:acme:error:accountDoesNotExist', 'no key')
      return null
    }
    const signed = Buffer.from(`${jws.protected}.${jws.payload ?? ''}`, 'utf8')
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    if (!verify('sha256', signed, key, rawToDer(Buffer.from(jws.signature, 'base64url')))) {
      problem(response, 400, 'urn:ietf:params:acme:error:malformed', 'the signature does not verify')
      return null
    }
    if (badNonceLeft > 0) {
      badNonceLeft -= 1
      problem(response, 400, 'urn:ietf:params:acme:error:badNonce', 'stale nonce, try again')
      return null
    }
    const nonce = String(header.nonce ?? '')
    if (!nonces.delete(nonce)) {
      problem(response, 400, 'urn:ietf:params:acme:error:badNonce', 'unknown nonce')
      return null
    }
    const payload =
      jws.payload === undefined || jws.payload === ''
        ? {}
        : (JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) as Record<string, unknown>)
    return { header: header as Record<string, string>, payload }
  }

  /** The CA's own resolver: a real UDP question to our real dns-server. */
  const readTxt = async (host: string): Promise<string[]> => {
    const reply = await askUdp(options.dnsPort, buildQuery({ name: host, type: T.TXT, edns: 4096 }), 1500)
    if (reply === null) return []
    const answer = parseAnswer(reply)
    return answer.rcode === 0 ? answer.answers.filter((r) => r.type === T.TXT).map((r) => r.data) : []
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '/'
      if (url === '/directory') {
        send(response, 200, {
          newNonce: `${base}/nonce`,
          newAccount: `${base}/new-account`,
          newOrder: `${base}/new-order`,
          revokeCert: `${base}/revoke`,
          keyChange: `${base}/key-change`
        })
        return
      }
      if (url === '/nonce') {
        response.writeHead(200, { 'replay-nonce': mint(), 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (request.method !== 'POST') {
        problem(response, 405, 'urn:ietf:params:acme:error:malformed', 'POST only')
        return
      }
      const opened = open(await body(request), response)
      if (opened === null) return

      if (url === '/new-account') {
        accountJwk = (opened.header.jwk as unknown as typeof accountJwk) ?? accountJwk
        send(response, 201, { status: 'valid' }, { location: `${base}/account/1` })
        return
      }
      if (url === '/new-order') {
        const identifiers = (opened.payload.identifiers as { value: string }[]).map((one) => one.value)
        const id = String(orders.size + 1)
        // `localhost` and `127.0.0.1` are the same machine and different
        // origins, which is exactly the distinction being tested.
        const elsewhere = options.offOriginUrls === true ? base.replace('127.0.0.1', 'localhost') : base
        const authz = identifiers.map((value, i) => {
          const authzId = `${id}-${i}`
          authzs.set(authzId, {
            id: authzId,
            // A wildcard order authorises the BASE name; the challenge record
            // is `_acme-challenge.<base>` either way. Getting this wrong is
            // the classic dns-01 mistake, so the fake models it faithfully.
            value: value.replace(/^\*\./, ''),
            token: b64url(randomBytes(16)),
            status: 'pending'
          })
          return `${elsewhere}/authz/${authzId}`
        })
        orders.set(id, { id, identifiers, authz, status: 'pending' })
        send(
          response,
          201,
          { status: 'pending', identifiers: identifiers.map((value) => ({ type: 'dns', value })), authorizations: authz, finalize: `${elsewhere}/order/${id}/finalize` },
          { location: `${base}/order/${id}` }
        )
        return
      }
      const authzMatch = /^\/authz\/(.+)$/.exec(url)
      if (authzMatch !== null) {
        const held = authzs.get(authzMatch[1])
        if (held === undefined) return problem(response, 404, 'urn:ietf:params:acme:error:malformed', 'no authz')
        if (options.redirectAuthz === true) {
          response.writeHead(302, { location: `${base}/authz-moved/${held.id}`, 'replay-nonce': mint() })
          response.end()
          return
        }
        send(response, 200, {
          status: held.status,
          identifier: { type: 'dns', value: options.lieIdentifier ?? held.value },
          challenges: [{ type: 'dns-01', url: `${base}/chall/${held.id}`, token: held.token, status: held.status }],
          ...(held.status === 'invalid' ? { error: { detail: 'no valid TXT record found' } } : {})
        })
        return
      }
      const challMatch = /^\/chall\/(.+)$/.exec(url)
      if (challMatch !== null) {
        const held = authzs.get(challMatch[1])
        if (held === undefined || accountJwk === null) {
          return problem(response, 404, 'urn:ietf:params:acme:error:malformed', 'no challenge')
        }
        const wanted = b64url(
          createHash('sha256').update(`${held.token}.${thumbprint(accountJwk)}`, 'utf8').digest()
        )
        if (options.challengeDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.challengeDelayMs))
        }
        const texts = await readTxt(`_acme-challenge.${held.value}`)
        seen.push(texts)
        held.status = options.refuseAll === true || !texts.includes(wanted) ? 'invalid' : 'valid'
        if (held.status === 'valid') {
          for (const order of orders.values()) {
            if (order.authz.some((one) => one.endsWith(`/${held.id}`)) && order.status === 'pending') {
              if (order.authz.every((one) => authzs.get(one.split('/').pop() ?? '')?.status === 'valid')) {
                order.status = 'ready'
              }
            }
          }
        }
        send(response, 200, { type: 'dns-01', url: `${base}/chall/${held.id}`, token: held.token, status: 'processing' })
        return
      }
      const finalizeMatch = /^\/order\/(.+)\/finalize$/.exec(url)
      if (finalizeMatch !== null) {
        const order = orders.get(finalizeMatch[1])
        if (order === undefined || order.status !== 'ready') {
          return problem(response, 403, 'urn:ietf:params:acme:error:orderNotReady', 'not ready')
        }
        const der = Buffer.from(String(opened.payload.csr), 'base64url')
        const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`
        order.chain = issueLeaf({
          ca: options.ca,
          spki: spkiFromCsr(pem),
          names: order.identifiers,
          serial: issued + 1,
          notBefore: new Date(Date.now() - 3600_000),
          notAfter: options.notAfter ?? new Date(Date.now() + 90 * 86400_000)
        })
        issued += 1
        order.status = 'valid'
        send(response, 200, { status: 'valid', certificate: `${base}/cert/${order.id}` }, { location: `${base}/order/${order.id}` })
        return
      }
      const orderMatch = /^\/order\/(.+)$/.exec(url)
      if (orderMatch !== null) {
        const order = orders.get(orderMatch[1])
        if (order === undefined) return problem(response, 404, 'urn:ietf:params:acme:error:malformed', 'no order')
        send(response, 200, {
          status: order.status,
          identifiers: order.identifiers.map((value) => ({ type: 'dns', value })),
          authorizations: order.authz,
          finalize: `${base}/order/${order.id}/finalize`,
          ...(order.status === 'valid' ? { certificate: `${base}/cert/${order.id}` } : {})
        })
        return
      }
      const certMatch = /^\/cert\/(.+)$/.exec(url)
      if (certMatch !== null) {
        const order = orders.get(certMatch[1])
        if (order?.chain === undefined) return problem(response, 404, 'urn:ietf:params:acme:error:malformed', 'no chain')
        send(response, 200, order.chain)
        return
      }
      problem(response, 404, 'urn:ietf:params:acme:error:malformed', 'no such resource')
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    directory: `${base}/directory`,
    issued: () => issued,
    seen: () => seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
