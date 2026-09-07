// THE MAC KEEPS WHAT THE PHONE FOUND, SO NOBODY SENDS A PHOTOGRAPH.
//
// The owner's phone showed four LAN candidates saying "no answer" and a
// 13,328 ms relay round trip, and the only way to look at it from the desk was
// a picture of a phone screen. POST /api/path/report files each race; GET
// /api/path/reports hands the last few back to a curl on the Mac.
//
// What must hold, and each of these has bitten something in this codebase
// before: the buffer is BOUNDED on both axes (it is a diagnostic, not a log),
// a body is never trusted just because the caller was authenticated (these
// strings are printed in a terminal and served back as JSON), the device is
// the BRIDGE's to name and never the body's, and the log line carries no
// address and no token — it is the one part of this that a person may see
// over a shoulder.

import http from 'node:http'
import { Readable } from 'node:stream'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { PATH_REPORTS_ROUTE, PATH_REPORT_ROUTE } from '../src/shared/path-report'
import { handlePathReportRoutes } from '../src/main/path-report-routes'
import {
  createPathReportStore,
  outcomeSummary,
  pathReportLine,
  type PathReportDevice,
  type PathReportStore
} from '../src/main/path-reports'
import { PATH_REPORTS_KEPT, PATH_REPORT_DEVICES_KEPT } from '../src/shared/path-report'

const PHONE: PathReportDevice = {
  deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: "Andrej's iPhone"
}

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: 1_800_000_000_000,
  plane: 'RELAY',
  permission: 'denied',
  browser: 'Chrome 142',
  attempts: [
    { name: '192.168.1.24:8643', outcome: 'blocked', ms: 1, detail: 'TypeError: Failed to fetch' },
    { name: '10.0.0.9:8643', outcome: 'timeout', ms: 800 }
  ],
  ...over
})

describe('the store', () => {
  it('keeps a report, with who it came from and when it arrived', () => {
    const store = createPathReportStore({ now: () => 42, log: () => undefined })
    const kept = store.record(PHONE, report())
    expect(kept?.device).toBe("Andrej's iPhone")
    expect(kept?.receivedAt).toBe(42)
    expect(kept?.attempts).toHaveLength(2)
    expect(store.list()).toHaveLength(1)
  })

  it('refuses a body that is not a report, rather than storing a shape', () => {
    const store = createPathReportStore({ log: () => undefined })
    expect(store.record(PHONE, null)).toBe(null)
    expect(store.record(PHONE, { plane: 'MOON', attempts: [] })).toBe(null)
    expect(store.record(PHONE, { plane: 'LAN' })).toBe(null)
    expect(store.list()).toEqual([])
  })

  it('cuts a hostile string down before it is ever printed or served', () => {
    // These are drawn in a terminal. An escape sequence in a "detail" is a
    // terminal being driven by a phone.
    const store = createPathReportStore({ log: () => undefined })
    const kept = store.record(
      PHONE,
      report({
        browser: 'Chrome\u001b[2J 142',
        attempts: [
          { name: 'x'.repeat(400), outcome: 'blocked', ms: 1, detail: '\u001b]0;owned\u0007' }
        ]
      })
    )
    expect(kept?.browser).not.toContain('\u001b')
    expect(kept?.attempts[0].detail ?? '').not.toContain('\u001b')
    expect(kept?.attempts[0].name.length).toBeLessThanOrEqual(120)
    // A round trip is a number or it is nothing; NaN in a diagnostic is worse
    // than a gap, because it reads as a measurement.
    const odd = store.record(PHONE, report({ attempts: [{ name: 'a', outcome: 'timeout', ms: 'soon' }] }))
    expect(odd?.attempts[0].ms).toBe(null)
  })

  it('keeps twenty per device and no more', () => {
    const store = createPathReportStore({ log: () => undefined })
    for (let i = 0; i < PATH_REPORTS_KEPT + 5; i += 1) store.record(PHONE, report({ at: i }))
    const kept = store.list()
    expect(kept).toHaveLength(PATH_REPORTS_KEPT)
    // Newest first, so a curl shows the race that just happened at the top.
    expect(kept[0].at).toBe(PATH_REPORTS_KEPT + 4)
  })

  it('holds a bounded number of devices, oldest reporter out first', () => {
    const store = createPathReportStore({ log: () => undefined })
    for (let i = 0; i < PATH_REPORT_DEVICES_KEPT + 3; i += 1) {
      store.record({ deviceId: `device-${i}` }, report())
    }
    expect(store.list()).toHaveLength(PATH_REPORT_DEVICES_KEPT)
  })

  it('files a report from a direct plane as unnamed, never as somebody', () => {
    // A direct request carries no bridge headers, so nothing NAMES the phone —
    // and a body that could name itself would let one admitted phone write
    // rows into another's history.
    const store = createPathReportStore({ log: () => undefined })
    const kept = store.record({ deviceId: null }, report({ device: 'somebody else' }))
    expect(kept?.device).toBe(null)
    expect(JSON.stringify(kept)).not.toContain('somebody else')
  })
})

describe('the one line it logs', () => {
  it('names the device, the plane and a count per outcome', () => {
    const said: string[] = []
    const store = createPathReportStore({ now: () => 42, log: (line) => said.push(line) })
    store.record(PHONE, report())
    expect(said).toEqual([
      "[cookrew] path report from Andrej's iPhone: RELAY · 2 candidates · 1 blocked, 1 timeout"
    ])
  })

  it('carries no address, no detail and no token', () => {
    const said: string[] = []
    const store = createPathReportStore({ log: (line) => said.push(line) })
    store.record(PHONE, report())
    expect(said[0]).not.toContain('192.168')
    expect(said[0]).not.toContain('8643')
    expect(said[0]).not.toContain('TypeError')
    expect(said[0].toLowerCase()).not.toContain('token')
  })

  it('says so plainly when a phone reports an unnamed device', () => {
    const said: string[] = []
    const store = createPathReportStore({ log: (line) => said.push(line) })
    store.record({ deviceId: null }, report({ attempts: [] }))
    expect(said[0]).toContain('an unnamed phone')
    expect(said[0]).toContain('0 candidates · nothing tried')
  })

  it('summarises in the order the outcomes first appear', () => {
    expect(
      outcomeSummary([
        { name: 'a', outcome: 'timeout', ms: 800 },
        { name: 'b', outcome: 'blocked', ms: 1 },
        { name: 'c', outcome: 'blocked', ms: 2 }
      ])
    ).toBe('1 timeout, 2 blocked')
  })

  it('says one candidate, not one candidates', () => {
    expect(
      pathReportLine({
        at: 1,
        receivedAt: 1,
        device: 'a phone',
        plane: 'LAN',
        permission: 'granted',
        browser: 'Safari 17',
        attempts: [{ name: 'a', outcome: 'answered', ms: 6 }]
      })
    ).toContain('1 candidate · 1 answered')
  })
})

describe('the two routes', () => {
  const servers: http.Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  const start = async (store: PathReportStore, device: PathReportDevice): Promise<number> => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handlePathReportRoutes(request, response, url, { device, store }).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  it('takes a report and hands it back', async () => {
    const store = createPathReportStore({ now: () => 42, log: () => undefined })
    const port = await start(store, PHONE)
    const posted = await fetch(`http://127.0.0.1:${port}/api/path/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report())
    })
    expect(posted.status).toBe(204)

    const read = await fetch(`http://127.0.0.1:${port}/api/path/reports`)
    const body = (await read.json()) as { count: number; reports: { device: string }[] }
    expect(read.status).toBe(200)
    expect(body.count).toBe(1)
    expect(body.reports[0].device).toBe("Andrej's iPhone")
  })

  it('400s a body that is not a report, rather than keeping a shape', async () => {
    const store = createPathReportStore({ log: () => undefined })
    const port = await start(store, PHONE)
    const posted = await fetch(`http://127.0.0.1:${port}/api/path/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all'
    })
    expect(posted.status).toBe(400)
    expect(store.list()).toEqual([])
  })

  it('answers nothing else, so it cannot shadow a route it does not own', async () => {
    const store = createPathReportStore({ log: () => undefined })
    const port = await start(store, PHONE)
    // Wrong method on its own path, and the neighbouring reach route.
    expect((await fetch(`http://127.0.0.1:${port}/api/path/report`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/api/reach`)).status).toBe(404)
  })

  it('never echoes a token back, whatever a phone puts in the body', async () => {
    const store = createPathReportStore({ log: () => undefined })
    const port = await start(store, PHONE)
    await fetch(`http://127.0.0.1:${port}/api/path/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report({ token: 'a-very-secret-pairing-token' }))
    })
    const text = await (await fetch(`http://127.0.0.1:${port}/api/path/reports`)).text()
    expect(text).not.toContain('a-very-secret-pairing-token')
    expect(text.toLowerCase()).not.toContain('token')
  })
})

describe('the gate these two routes sit behind', () => {
  // They answer BELOW mobile-server's delegation to handleMobileApi, which is
  // the one choke point where a credential is checked. This is what that claim
  // means in practice — and a second copy of the check inside the routes would
  // be a second thing to keep in step, which is how the read hole this gate
  // was written for got there in the first place.
  const TOKEN = 'pairing-token-123'

  const request = (method: string, authorization?: string): http.IncomingMessage => {
    const stub = Readable.from([]) as http.IncomingMessage
    stub.method = method
    stub.headers = authorization ? { authorization } : {}
    return stub
  }

  const answered = async (
    method: string,
    route: string,
    authorization?: string
  ): Promise<{ handled: boolean; status: number }> => {
    let status = 0
    const response = {
      writeHead(code: number) {
        status = code
        return this
      },
      end() {
        return undefined
      }
    } as unknown as http.ServerResponse
    const handled = await handleMobileApi(
      request(method, authorization),
      response,
      new URL(route, 'http://lan.local'),
      { pairingToken: TOKEN } as unknown as MobileApiDeps
    )
    return { handled, status }
  }

  it('401s a report POSTed without a credential, before the route is reached', async () => {
    expect(await answered('POST', PATH_REPORT_ROUTE)).toEqual({ handled: true, status: 401 })
  })

  it('401s a read of the reports without a credential', async () => {
    expect(await answered('GET', PATH_REPORTS_ROUTE)).toEqual({ handled: true, status: 401 })
  })

  it('lets an authenticated caller fall through to the routes themselves', async () => {
    // handleMobileApi owns neither path, so `handled` is false and the request
    // continues to handlePathReportRoutes in mobile-server.
    expect(await answered('POST', PATH_REPORT_ROUTE, `Bearer ${TOKEN}`)).toEqual({
      handled: false,
      status: 0
    })
    expect(await answered('GET', PATH_REPORTS_ROUTE, `Bearer ${TOKEN}`)).toEqual({
      handled: false,
      status: 0
    })
  })
})
