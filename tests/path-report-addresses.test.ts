// A PATH REPORT NAMES THE MAC'S ADDRESSES, SO IT TRAVELS ONLY INSIDE COOKREW-SEAL/2.
//
// Security review, 2026-11-19: a race's rows carry `link.via` (the Mac's LAN
// or tailnet address), the candidates' address forms and the browser's own
// words, which may spell an address any way at all. The phone POSTed them
// with planeFetch, which goes plain over the relay whenever no sealed session
// is pinned, and GET /api/path/reports answered the read-only wall token and a
// plain relay request alike.
//
// No pattern over free text can promise an address is gone, so nothing is
// redacted: the report goes whole, or not at all.
//   - the phone hands it only to the sealed sender; without one, it stays on
//     the phone (the next race offers it again);
//   - the Mac files a POST only from a cookrew-seal/2 inner request
//     (seal-proof.ts · sealedV2Of), and answers a GET only there and only to
//     the owner's pairing. Plain relay, a v1 seal, a forged marker, a loopback
//     curl and the wall token are all refused, whatever is already held.
//
// INCOMPATIBLE ON PURPOSE with a console older than this: its plain POST is
// refused (403) and its reports are lost, as its RTC offer already is.

import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathReporter, postPathReport } from '../src/renderer/src/path/report'
import type { PathReport } from '../src/shared/path-report'
import { handlePathReportRoutes } from '../src/main/path-report-routes'
import { createPathReportStore, type PathReportStore } from '../src/main/path-reports'
import { SEALED_V2_HEADER, sealProofHeaders } from '../src/main/seal-proof'
import { RELAY_MARKER } from '../src/main/canvas-bridge'

const LAN = '192.168.1.24'

const report = (over: Partial<PathReport> = {}): PathReport => ({
  at: 1_800_000_000_000,
  plane: 'RELAY',
  permission: 'granted',
  browser: 'Chrome 142',
  attempts: [{ name: `${LAN}:8643`, outcome: 'blocked', ms: 1, detail: `connect to ${LAN}:8643 refused` }],
  probes: [{ kind: 'rtc', name: `${LAN} closed: the plane moved (pong 12/40 ms)`, outcome: 'closed', ms: 9000 }],
  ...over
})

describe('what leaves the phone', () => {
  it('goes whole, inside the sealed session', async () => {
    const sent: string[] = []
    await postPathReport(report(), {
      url: '/api/path/report',
      headers: { authorization: 'Bearer t' },
      sealed: (_url, init) => {
        sent.push(String(init.body))
        return Promise.resolve({ ok: true, status: 204 })
      }
    })
    expect(sent).toHaveLength(1)
    // Nothing redacted: the diagnosis is intact where it is allowed to go.
    expect(JSON.parse(sent[0]).probes[0].name).toBe(`${LAN} closed: the plane moved (pong 12/40 ms)`)
  })

  it('stays on the phone when there is no sealed session: there is no other sender', async () => {
    await expect(
      postPathReport(report(), { url: '/api/path/report', headers: {}, sealed: () => null })
    ).rejects.toThrow('a sealed session is required')
  })

  it('fails, never falls back, when the sealed session fails', async () => {
    await expect(
      postPathReport(report(), {
        url: '/api/path/report',
        headers: {},
        sealed: () => Promise.reject(new Error('sealed session closed'))
      })
    ).rejects.toThrow('sealed session closed')
  })

  it('rejects when the Mac refuses the sealed post', async () => {
    await expect(
      postPathReport(report(), { url: '/api/path/report', headers: {}, sealed: async () => ({ ok: false, status: 403 }) })
    ).rejects.toThrow('403')
  })

  it('is offered again by the next race once a sealed session exists', async () => {
    let session = false
    const sent: string[] = []
    const clock = { ms: 0 }
    const tell = createPathReporter({
      now: () => clock.ms,
      post: (one) =>
        postPathReport(one, {
          url: '/api/path/report',
          headers: {},
          sealed: (_url, init) => {
            if (!session) return null
            sent.push(String(init.body))
            return Promise.resolve({ ok: true, status: 204 })
          }
        })
    })
    expect(await tell(report())).toBe(false)
    session = true
    clock.ms = 60_000
    expect(await tell(report())).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe('POST requires owner authorization too', () => {
  it('rejects a trusted v2 transport when owner authorization is absent', async () => {
    const store = createPathReportStore()
    const server = http.createServer((request, response) => {
      void handlePathReportRoutes(request, response, new URL(request.url ?? '/', 'http://localhost'), { device: { deviceId: null }, store, owner: false })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as net.AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/api/path/report`, {
        method: 'POST', headers: { ...sealProofHeaders(), [SEALED_V2_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify(report())
      })
      expect(response.status).toBe(403)
      expect(store.list()).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('what the Mac files and hands back', () => {
  const servers: http.Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  const start = async (store: PathReportStore, owner: boolean): Promise<number> => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handlePathReportRoutes(request, response, url, { device: { deviceId: null }, store, owner }).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const RELAYED = { [RELAY_MARKER]: '1' }
  const SEALED_V2 = { ...RELAYED, ...sealProofHeaders(), [SEALED_V2_HEADER]: '1' }
  const UNSEALED_ROADS: readonly (readonly [string, Record<string, string>])[] = [
    ['plain over the relay', RELAYED],
    ['inside a v1 seal', { ...RELAYED, ...sealProofHeaders() }],
    ['with a forged v2 marker', { ...RELAYED, [SEALED_V2_HEADER]: '1', 'x-cookrew-sealed': 'not-the-proof' }],
    ['with a v2 marker and no proof at all', { [SEALED_V2_HEADER]: '1' }],
    ['from a loopback curl on the Mac', {}]
  ]

  const post = (port: number, headers: Record<string, string>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/path/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(report())
    })

  const get = (port: number, headers: Record<string, string>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/path/reports`, { headers })

  /** A report already held, as one filed before this change would be. */
  const holding = (): PathReportStore => {
    const store = createPathReportStore({ log: () => undefined })
    store.record({ deviceId: null }, report())
    return store
  }

  it('files a report that came out of a v2 seal, whole', async () => {
    const store = createPathReportStore({ log: () => undefined })
    const port = await start(store, true)
    expect((await post(port, SEALED_V2)).status).toBe(204)
    expect(store.list()[0].attempts[0].name).toBe(`${LAN}:8643`)
  })

  it.each(UNSEALED_ROADS)('refuses a report sent %s, and files nothing', async (_road, headers) => {
    const store = createPathReportStore({ log: () => undefined })
    const port = await start(store, true)
    const answer = await post(port, headers)
    expect(answer.status).toBe(403)
    expect(await answer.text()).not.toContain(LAN)
    expect(store.list()).toEqual([])
  })

  it('hands the owner on a v2 seal the reports, whole', async () => {
    const port = await start(holding(), true)
    const answer = await get(port, SEALED_V2)
    expect(answer.status).toBe(200)
    expect(await answer.text()).toContain(`${LAN}:8643`)
  })

  it.each(UNSEALED_ROADS)('refuses the owner a read %s, whatever is held', async (_road, headers) => {
    const port = await start(holding(), true)
    const answer = await get(port, headers)
    expect(answer.status).toBe(403)
    expect(await answer.text()).not.toContain(LAN)
  })

  it('refuses the read-only wall token, even on a v2 seal', async () => {
    const port = await start(holding(), false)
    const answer = await get(port, SEALED_V2)
    expect(answer.status).toBe(403)
    expect(await answer.text()).not.toContain(LAN)
  })

  it('refuses a read when no owner flag was given at all', async () => {
    const store = holding()
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handlePathReportRoutes(request, response, url, { device: { deviceId: null }, store })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    expect((await get(port, SEALED_V2)).status).toBe(403)
  })
})
