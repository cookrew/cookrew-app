// THE PHONE'S EAR (owner, 2026-11-03: "Android voice input does not work").
// The phone records (16 kHz WAV) and the Mac hears it with the same on-device
// ears ⌘-hold uses: POST /api/listen → main/hear-file.ts.

import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { isAndroid, pickEar, webEarUnreachable } from '../src/renderer/src/prompt/dictation'
import { downsample, HEAR_RATE, joinSamples, micErrorText, recordingWav, wavBytes } from '../src/renderer/src/prompt/phone-audio'
import { canRecord } from '../src/renderer/src/prompt/phone-recorder'
import { hearDeadlineMs } from '../src/renderer/src/prompt/use-dictation'
import { recordingSeconds } from '../src/main/hear-file'

const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'

describe('which ear hears', () => {
  it("the Mac's own ear first; then the phone's recording when preferred or when the browser has none", () => {
    expect(pickEar(true, true, true, true)).toBe('mac')
    expect(pickEar(false, true, true, true)).toBe('phone')
    expect(pickEar(false, false, true, false)).toBe('phone')
    expect(pickEar(false, true, true, false)).toBe('web')
    // Preferring the phone's ear is no use when the Mac cannot hear it.
    expect(pickEar(false, true, false, true)).toBe('web')
    expect(pickEar(false, false, false, true)).toBeNull()
  })

  it('Android is told by its user agent, not by Chrome', () => {
    expect(isAndroid('Mozilla/5.0 (Linux; Android 15; SM-S9280) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36')).toBe(true)
    expect(isAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1')).toBe(false)
    expect(isAndroid(undefined)).toBe(false)
  })

  it("only a missing service moves a browser off its own ear: silence and a refused mic do not", () => {
    expect(webEarUnreachable('network')).toBe(true)
    expect(webEarUnreachable('service-not-allowed')).toBe(true)
    expect(webEarUnreachable('language-not-supported')).toBe(true)
    expect(webEarUnreachable('not-allowed')).toBe(false)
    expect(webEarUnreachable('no-speech')).toBe(false)
    expect(webEarUnreachable(undefined)).toBe(false)
  })

  it('records only where there is a mic API and an AudioContext', () => {
    const mediaDevices = { getUserMedia: () => undefined }
    expect(canRecord({ AudioContext: function A() {}, navigator: { mediaDevices } })).toBe(true)
    expect(canRecord({ webkitAudioContext: function A() {}, navigator: { mediaDevices } })).toBe(true)
    // Plain-http LAN: not a secure context, no mediaDevices at all.
    expect(canRecord({ AudioContext: function A() {}, navigator: {} })).toBe(false)
    expect(canRecord(undefined)).toBe(false)
  })
})

describe('the recording', () => {
  it('joins the chunks in order', () => {
    expect([...joinSamples([new Float32Array([1, 2]), new Float32Array([3])])]).toEqual([1, 2, 3])
  })

  it('48 kHz goes up at 16 kHz, each sample the mean of its span', () => {
    const out = downsample(new Float32Array([0.3, 0.6, 0.9, -0.3, -0.6, -0.9]), 48000, 16000)
    expect(out).toHaveLength(2)
    expect(out[0]).toBeCloseTo(0.6)
    expect(out[1]).toBeCloseTo(-0.6)
    const same = new Float32Array([1, 2])
    expect(downsample(same, 16000, 16000)).toBe(same)
  })

  it('is a PCM mono 16-bit WAV the Mac can read', () => {
    const bytes = wavBytes(new Float32Array([0, 1, -1, 2]), HEAR_RATE)
    const view = new DataView(bytes.buffer)
    const text = (at: number, n: number): string => String.fromCharCode(...bytes.slice(at, at + n))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 8)).toBe('WAVEfmt ')
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)
    // Clamped, not wrapped: 2 is full scale, not a click.
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767])
  })

  it('a tap with nothing in it sends nothing', () => {
    expect(recordingWav([new Float32Array(48000 * 0.1)], 48000)).toBeNull()
    const wav = recordingWav([new Float32Array(48000), new Float32Array(48000)], 48000)
    expect(wav?.length).toBe(44 + 2 * 16000 * 2)
  })

  it('the Mac gets the recording\'s length and a margin, on both sides of the wire', () => {
    // A minute of 16 kHz mono 16-bit WAV.
    const minute = 44 + 60 * HEAR_RATE * 2
    expect(recordingSeconds(minute)).toBe(61)
    expect(hearDeadlineMs(minute)).toBeGreaterThan(60_000 + 25_000)
    expect(hearDeadlineMs(minute)).toBeLessThan(60_000 + 35_000)
  })

  it("the mic's refusals read like the box's other ones", () => {
    expect(micErrorText({ name: 'NotAllowedError' })).toBe('The microphone is not allowed here.')
    expect(micErrorText({ name: 'NotFoundError' })).toBe('No microphone was found.')
    expect(micErrorText({ name: 'NotReadableError' })).toMatch(/busy/)
    expect(micErrorText(new Error('boom'))).toMatch(/boom/)
  })
})

describe('/api/listen', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (over: Partial<MobileApiDeps>): Promise<number> => {
    const deps = { pairingToken: PAIRING, wallToken: WALL, ...over } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const call = async (port: number, init: { method?: string; token?: string; body?: Uint8Array }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/listen`, {
      method: init.method ?? 'GET',
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { 'content-type': 'audio/wav' } : {}) },
      ...(init.body ? { body: new Blob([init.body.slice().buffer]) } : {})
    })
    const text = await response.text()
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }

  it('says whether this Mac can hear, and nothing without a token', async () => {
    const hear = { available: () => true, locale: () => 'zh-CN', recording: async () => ({ text: '', alternates: {} }) }
    const port = await startApi({ hear })
    expect((await call(port, {})).status).toBe(401)
    expect(await call(port, { token: PAIRING })).toEqual({ status: 200, body: { available: true, locale: 'zh-CN' } })
    const bare = await startApi({})
    expect(await call(bare, { token: PAIRING })).toEqual({ status: 200, body: { available: false, locale: null } })
  })

  it('hears the raw body and answers the words', async () => {
    const got: Uint8Array[] = []
    const hear = {
      available: () => true,
      locale: () => 'zh-CN',
      recording: async (bytes: Uint8Array) => {
        got.push(bytes)
        return { text: '让QQ给修一下字体大小', alternates: { 'en-US': 'ask Cookrew Dev to fix the font size' } }
      }
    }
    const port = await startApi({ hear })
    const wav = wavBytes(new Float32Array(8000), HEAR_RATE)
    const answer = await call(port, { method: 'POST', token: PAIRING, body: wav })
    expect(answer).toEqual({ status: 200, body: { text: '让QQ给修一下字体大小', alternates: { 'en-US': 'ask Cookrew Dev to fix the font size' } } })
    expect(got).toHaveLength(1)
    expect(Buffer.from(got[0]).equals(Buffer.from(wav))).toBe(true)
  })

  it("is a write: the read-only wall token may not make the Mac listen", async () => {
    const hear = { available: () => true, locale: () => 'zh-CN', recording: async () => ({ text: 'x', alternates: {} }) }
    const port = await startApi({ hear })
    const answer = await call(port, { method: 'POST', token: WALL, body: new Uint8Array([1, 2, 3]) })
    expect(answer.status).toBe(401)
  })

  it("503 with no ear, 422 with the helper's own words when it fails", async () => {
    const none = await startApi({})
    expect((await call(none, { method: 'POST', token: PAIRING, body: new Uint8Array([1]) })).status).toBe(503)
    const failing = {
      available: () => true,
      locale: () => 'zh-CN',
      recording: async () => {
        throw new Error('recognition failed: Siri and Dictation are disabled')
      }
    }
    const port = await startApi({ hear: failing })
    expect(await call(port, { method: 'POST', token: PAIRING, body: new Uint8Array([1]) })).toEqual({
      status: 422,
      body: { error: 'recognition failed: Siri and Dictation are disabled' }
    })
  })
})
