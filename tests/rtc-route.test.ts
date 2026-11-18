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

  const start = async (answer: (sdp: string) => Promise<string | null>, bind?: (offerSdp: string, answerSdp: string) => unknown) => {
    const deps = { pairingToken: TOKEN, turns: { list: () => [] }, rtc: bind ? { answer, bind } : { answer } } as unknown as MobileApiDeps
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

  it('sends the binding beside the answer, made over the offer as it arrived and the answer as sent', async () => {
    const asked: unknown[] = []
    const post = await start(
      async (sdp) => `answer-to:${sdp}`,
      (offerSdp, answerSdp) => {
        asked.push([offerSdp, answerSdp])
        return { v: 1, device: 'mac-1', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' }, sig: 'sig' }
      }
    )
    const res = await post({ sdp: 'v=0 offer' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sdp: 'answer-to:v=0 offer', bind: { v: 1, device: 'mac-1', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' }, sig: 'sig' } })
    expect(asked).toEqual([['v=0 offer', 'answer-to:v=0 offer']])
  })

  it('still answers, with no binding, when there is nothing to bind by or binding fails', async () => {
    // The console then refuses the answer and stays on the relay; the route itself stays additive.
    for (const bind of [() => null, () => { throw new Error('locked') }, async () => { throw new Error('locked') }]) {
      const post = await start(async () => 'answer', bind)
      const res = await post({ sdp: 'v=0' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sdp: 'answer' })
    }
  })

  it('binds nothing when the Mac offers no link', async () => {
    let bound = 0
    const post = await start(async () => null, () => ((bound += 1), null))
    expect((await post({ sdp: 'v=0' })).status).toBe(503)
    expect(bound).toBe(0)
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

  it('runs only on the relay, first in each race, and rides the race report', () => {
    const src = readFileSync('src/renderer/src/path/companion.ts', 'utf8')
    expect(src).toContain("dataPlane().kind !== 'relay'")
    expect(src).toContain('const RTC_EVERY_MS = 2 * 60 * 1000')
    // Before the names, unless the plane just failed or the phone is on a radio (no LAN in reach).
    expect(src).toContain('const knocked = health.held() || onCellular() ? [] : await rtcKnock(raceSoon, live)')
    expect(src).toContain('reportLinkRows(knocked)')
    // A link that ended, however, is knocked again at once, not after the gap.
    expect(src).toMatch(/ended: \(row\) => \{[\s\S]{0,400}lastRtcAt = 0[\s\S]{0,40}onEnd\(\)/)
    // The knocks and the navigation home are gone with the offer that drove them.
    expect(src).not.toMatch(/probeReach|homeJump|location\.assign/)
  })
})
