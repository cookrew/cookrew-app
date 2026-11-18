import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loopbackDialer } from '../src/main/canvas-bridge'
import { createSealMarks, MARK_MS } from '../src/main/seal-marks'
import { cameOverRelayLine, RELAY_LINE_MARKER, relayLineHeaders } from '../src/main/seal-proof'

const dirs: string[] = []
const fileIn = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-marks-'))
  dirs.push(dir)
  return path.join(dir, 'seal-marks.json')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const PHONE = '0f0e0d0c-0b0a-4908-8706-050403020100'
const OTHER = '48e5b104-a62d-8f13-a322-2b66aee4dbeb'

describe('seal marks', () => {
  it('refuses a marked device, and nobody else, until sealed only', () => {
    const file = fileIn()
    const marks = createSealMarks(file)
    expect(marks.refuses(PHONE)).toBe(false)
    marks.mark(PHONE.toUpperCase())
    expect(marks.refuses(PHONE)).toBe(true)
    expect(marks.refuses(OTHER)).toBe(false)
    expect(marks.refuses(null)).toBe(false)
    marks.setSealedOnly(true)
    expect(marks.refuses(OTHER)).toBe(true)
    expect(marks.refuses(null)).toBe(true)
    // It is kept across a restart.
    expect(createSealMarks(file).refuses(PHONE)).toBe(true)
    expect(createSealMarks(file).sealedOnly()).toBe(true)
  })

  it('a new code clears the devices but not the owner\'s switch', () => {
    const marks = createSealMarks(fileIn())
    marks.mark(PHONE)
    marks.setSealedOnly(true)
    marks.clearDevices()
    expect(marks.marked()).toEqual([])
    expect(marks.sealedOnly()).toBe(true)
  })

  it('a file that is there and cannot be read fails closed', () => {
    const file = fileIn()
    writeFileSync(file, '{ broken')
    expect(createSealMarks(file).refuses(OTHER)).toBe(true)
    writeFileSync(file, JSON.stringify({ devices: {} }))
    expect(createSealMarks(file).refuses(OTHER)).toBe(true)
  })

  it('ignores what is not a device id', () => {
    const file = fileIn()
    const marks = createSealMarks(file)
    marks.mark('../../etc/passwd')
    expect(marks.marked()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('a mark lapses a month after the device\'s last v2 session, and each session renews it', () => {
    let at = 1_000
    const marks = createSealMarks(fileIn(), () => at)
    marks.mark(PHONE)
    at += MARK_MS - 1
    expect(marks.refuses(PHONE)).toBe(true)
    marks.mark(PHONE)
    at += 2
    expect(marks.refuses(PHONE)).toBe(true)
    at += MARK_MS
    expect(marks.refuses(PHONE)).toBe(false)
  })
})

describe('the relay line proof', () => {
  it('only the line\'s own dialer can say a request came down the relay line: a caller\'s copy is taken off', async () => {
    const said: boolean[] = []
    const server = http.createServer((request, response) => {
      said.push(cameOverRelayLine(request))
      response.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const ask = (dial: ReturnType<typeof loopbackDialer>, headers: Record<string, string>): Promise<void> =>
      new Promise((resolve, reject) => {
        const call = dial({ method: 'GET', path: '/x', headers }, (answer) => (answer.onData(() => undefined), answer.onEnd(resolve)), reject)
        call.end()
      })
    const forged = { [RELAY_LINE_MARKER]: relayLineHeaders()[RELAY_LINE_MARKER].replace(/.$/, 'A') }
    await ask(loopbackDialer(port), forged)
    await ask(loopbackDialer(port), relayLineHeaders())
    await ask(loopbackDialer(port, undefined, relayLineHeaders()), {})
    server.close()
    expect(said).toEqual([false, false, true])
  })

  it('the companion refuses a marked caller before any route reads the request', () => {
    const source = readFileSync('src/main/mobile-server.ts', 'utf8')
    const taken = source.indexOf('const bridgeDevice = takeRelayDevice(request)')
    const gate = source.indexOf('if (cameOverRelayLine(request) && deps.sealMarks?.()?.refuses(bridgeDevice?.deviceId ?? null))')
    const firstRoute = source.indexOf('const route = deps.multiInstance()')
    expect(taken).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(taken)
    expect(gate).toBeLessThan(firstRoute)
    const index = readFileSync('src/main/index.ts', 'utf8')
    expect(index).toMatch(/dial: loopbackDialer\(MOBILE_PORT, undefined, relayLineHeaders\(\)\)/)
    expect(index).toMatch(/sealMarks: \(\) => sealMarks/)
  })
})
