// WHAT SAYS A REQUEST CAME OUT OF THE SEALED SESSION. The relay can write any header
// on a plain request, so this has to be something the relay has never seen.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { loopbackDialer } from '../src/main/canvas-bridge'
import { carriesSealProof, sealProofHeaders } from '../src/main/seal-proof'
import { SEALED_MARKER } from '../src/shared/remote-unlock'

const asRequest = (headers: IncomingHttpHeaders): http.IncomingMessage => ({ headers }) as http.IncomingMessage

describe('the proof', () => {
  it('is believed from the terminus, and from nobody else', () => {
    expect(carriesSealProof(asRequest(sealProofHeaders()))).toBe(true)
    expect(carriesSealProof(asRequest({}))).toBe(false)
    expect(carriesSealProof(asRequest({ [SEALED_MARKER]: '1' }))).toBe(false)
    expect(carriesSealProof(asRequest({ [SEALED_MARKER]: '' }))).toBe(false)
    expect(carriesSealProof(asRequest({ [SEALED_MARKER]: ['a', 'b'] }))).toBe(false)
  })
})

describe('the dialer', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      server.close()
    }
  })

  const heard = async (marks: Record<string, string> | undefined, headers: Record<string, string>): Promise<IncomingHttpHeaders> => {
    const seen: IncomingHttpHeaders[] = []
    const server = createServer((request, response) => {
      seen.push(request.headers)
      response.end('ok')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const dial = loopbackDialer((server.address() as AddressInfo).port, '127.0.0.1', marks)
    await new Promise<void>((resolve, reject) => {
      const call = dial({ method: 'GET', path: '/', headers }, (response) => {
        response.onData(() => undefined)
        response.onEnd(resolve)
      }, reject)
      call.end()
    })
    return seen[0]
  }

  it('a plain relayed request cannot carry the marker in, whatever it sends', async () => {
    expect((await heard(undefined, { [SEALED_MARKER]: 'forged' }))[SEALED_MARKER]).toBeUndefined()
  })

  it('the terminus\'s own dialer writes it over anything the phone said', async () => {
    const said = await heard(sealProofHeaders(), { [SEALED_MARKER]: 'forged' })
    expect(carriesSealProof(asRequest(said))).toBe(true)
  })
})
