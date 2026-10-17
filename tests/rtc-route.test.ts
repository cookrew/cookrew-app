// THE OFFER ROUTE: owner token only, an answer from the Mac's end, and the
// rtc row kept by the path report reader.
import http from 'node:http'
import type net from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { readPathReport } from '../src/main/path-reports'

const TOKEN = 'pairing-token-123'

describe('POST /api/rtc/offer', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => cleanup.splice(0).forEach((run) => run()))

  const start = async (answer: (sdp: string) => Promise<string | null>) => {
    const deps = { pairingToken: TOKEN, turns: { list: () => [] }, rtc: { answer } } as unknown as MobileApiDeps
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      void handleMobileApi(req, res, url, deps).then((handled) => { if (!handled) res.writeHead(404).end() })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    return (body: unknown, token: string | null = TOKEN) =>
      fetch(`http://127.0.0.1:${port}/api/rtc/offer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
      })
  }

  it('answers an offer with the Mac end\'s SDP', async () => {
    const post = await start(async (sdp) => `answer-to:${sdp}`)
    const res = await post({ sdp: 'v=0' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sdp: 'answer-to:v=0' })
  })

  it('refuses without the owner token, without an sdp, and when the Mac offers no link', async () => {
    const post = await start(async () => null)
    expect((await post({ sdp: 'v=0' }, null)).status).toBe(401)
    expect((await post({})).status).toBe(400)
    expect((await post({ sdp: 'v=0' })).status).toBe(503)
  })

  it('a throwing answer is a 400, not a crash', async () => {
    const post = await start(async () => { throw new Error('bad sdp') })
    expect((await post({ sdp: 'garbage' })).status).toBe(400)
  })
})

describe('the rtc row in a path report', () => {
  it('is kept by the reader', () => {
    const report = readPathReport(
      { plane: 'RELAY', permission: 'unsupported', browser: 'Safari 26', attempts: [], probes: [{ kind: 'rtc', name: '192.168.2.40', outcome: 'answered', ms: 420 }] },
      1
    )
    expect(report?.probes).toEqual([{ kind: 'rtc', name: '192.168.2.40', outcome: 'answered', ms: 420 }])
  })

  it('runs only on the relay, at most every two minutes, beside the knocks', () => {
    const src = readFileSync('src/renderer/src/path/companion.ts', 'utf8')
    expect(src).toContain("dataPlane().kind !== 'relay'")
    expect(src).toContain('const RTC_EVERY_MS = 2 * 60 * 1000')
    expect(src).toContain('Promise.all([probeReach(offer.origin), rtcKnock()])')
  })
})
