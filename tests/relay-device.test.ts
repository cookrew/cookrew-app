import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEVICE_NAME_MAX,
  RELAY_DEVICE_HEADER,
  RELAY_DEVICE_NAME_HEADER,
  relayDeviceOf,
  safeDeviceName,
  takeRelayDevice
} from '../src/main/relay-device'
import { loopbackDialer } from '../src/main/canvas-bridge'
import { createAdmittedDeviceStore, writeAdmittedDevices } from '../src/main/admitted-devices'
import { tempBase } from './support/idv2'

/**
 * WHO THE REGISTRY SAYS IS CALLING.
 *
 * The relay knows the caller's account session, so it can name the phone; the
 * Mac cannot, because down the bridge every request arrives from 127.0.0.1
 * with no identity of its own. So the registry sets two headers and the Mac
 * believes them ONLY under the two conditions relay-base already uses for
 * x-cookrew-base — the bridge's marker, and a loopback peer. Neither can be
 * arranged from the network, and both together are the same trust the prefix
 * already rides on.
 *
 * THEY GRANT NOTHING. Authorisation is the pairing token, on every path; these
 * headers only decide what the admitted-devices row is CALLED.
 */

const PHONE = '9f1c0a52-77b4-4a1e-9c33-5c7a2b0d8e11'

const at = (headers: Record<string, string>, remoteAddress = '127.0.0.1'): Parameters<typeof relayDeviceOf>[0] => ({
  marker: headers['x-cookrew-relay'],
  deviceId: headers[RELAY_DEVICE_HEADER],
  deviceName: headers[RELAY_DEVICE_NAME_HEADER],
  remoteAddress
})

describe('the device the bridge names', () => {
  it('is taken when the marker is set and the peer is loopback', () => {
    expect(
      relayDeviceOf(
        at({
          'x-cookrew-relay': '1',
          [RELAY_DEVICE_HEADER]: PHONE,
          [RELAY_DEVICE_NAME_HEADER]: 'Andrej iPhone'
        })
      )
    ).toEqual({ deviceId: PHONE, name: 'Andrej iPhone' })
  })

  it('takes the mapped form of loopback, which is how dual-stack peers arrive', () => {
    expect(
      relayDeviceOf(
        at({ 'x-cookrew-relay': '1', [RELAY_DEVICE_HEADER]: PHONE }, '::ffff:127.0.0.1')
      )
    ).toEqual({ deviceId: PHONE })
  })

  it('IS NOT TAKEN ON THE MARKER ALONE — a header is something a caller writes', () => {
    expect(
      relayDeviceOf(
        at({ 'x-cookrew-relay': '1', [RELAY_DEVICE_HEADER]: PHONE }, '192.168.1.9')
      )
    ).toBeNull()
  })

  it('is not taken on loopback alone either — the bridge sets the marker itself', () => {
    expect(relayDeviceOf(at({ [RELAY_DEVICE_HEADER]: PHONE }))).toBeNull()
  })

  it('refuses an id that is not a device id, however it is spelled', () => {
    for (const id of ['', 'not-a-uuid', '../../etc/passwd', `${PHONE} ${PHONE}`, 'x'.repeat(200)]) {
      expect(relayDeviceOf(at({ 'x-cookrew-relay': '1', [RELAY_DEVICE_HEADER]: id }))).toBeNull()
    }
  })

  it('carries no name rather than an empty one', () => {
    expect(
      relayDeviceOf(
        at({ 'x-cookrew-relay': '1', [RELAY_DEVICE_HEADER]: PHONE, [RELAY_DEVICE_NAME_HEADER]: '   ' })
      )
    ).toEqual({ deviceId: PHONE })
  })
})

describe('a device name is made safe before it is written down', () => {
  it('keeps ordinary printable ASCII and collapses whitespace', () => {
    expect(safeDeviceName("  Andrej's   iPhone  ")).toBe("Andrej's iPhone")
  })

  it('drops control characters and anything outside printable ASCII', () => {
    // The name is written to a 0600 JSON file and drawn in a sheet; a
    // terminal escape or a right-to-left override in it is somebody else's
    // problem to render, so the bytes that make one never get stored. What
    // survives an escape sequence is its ordinary text, and it reads as such.
    expect(safeDeviceName('iPhone\u0007\u001b[31m \u202e')).toBe('iPhone [31m')
    expect(safeDeviceName('iPhone 📱')).toBe('iPhone')
  })

  it('cuts at 64 characters', () => {
    expect(safeDeviceName('n'.repeat(200))).toHaveLength(DEVICE_NAME_MAX)
  })

  it('is undefined for a name with nothing left in it', () => {
    expect(safeDeviceName('📱')).toBeUndefined()
    expect(safeDeviceName('')).toBeUndefined()
    expect(safeDeviceName(undefined)).toBeUndefined()
    expect(safeDeviceName(['a', 'b'])).toBeUndefined()
  })
})

describe('the headers are stripped from every request, trusted or not', () => {
  const headersOf = (extra: Record<string, string>): http.IncomingMessage =>
    ({
      headers: { ...extra },
      socket: { remoteAddress: '192.168.1.9' }
    }) as unknown as http.IncomingMessage

  it('removes both headers even when the request had no business sending them', () => {
    const request = headersOf({
      [RELAY_DEVICE_HEADER]: PHONE,
      [RELAY_DEVICE_NAME_HEADER]: 'A LAN forgery'
    })
    expect(takeRelayDevice(request)).toBeNull()
    // Nothing downstream can read what it must not believe.
    expect(request.headers[RELAY_DEVICE_HEADER]).toBeUndefined()
    expect(request.headers[RELAY_DEVICE_NAME_HEADER]).toBeUndefined()
  })

  it('removes them after reading them on the trusted path too', () => {
    const request = {
      headers: {
        'x-cookrew-relay': '1',
        [RELAY_DEVICE_HEADER]: PHONE,
        [RELAY_DEVICE_NAME_HEADER]: 'iPhone'
      },
      socket: { remoteAddress: '127.0.0.1' }
    } as unknown as http.IncomingMessage
    expect(takeRelayDevice(request)).toEqual({ deviceId: PHONE, name: 'iPhone' })
    expect(request.headers[RELAY_DEVICE_HEADER]).toBeUndefined()
    expect(request.headers[RELAY_DEVICE_NAME_HEADER]).toBeUndefined()
  })
})

describe('over the real bridge dialer', () => {
  let server: http.Server
  let port = 0
  let seen: unknown = 'never asked'

  beforeEach(async () => {
    server = http.createServer((request, response) => {
      seen = takeRelayDevice(request)
      response.writeHead(200).end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )

  const dialed = (headers: Record<string, string>): Promise<void> =>
    new Promise((resolve, reject) => {
      const call = loopbackDialer(port)(
        { method: 'GET', path: '/api/workspace', headers },
        (response) => {
          response.onData(() => undefined)
          response.onEnd(resolve)
        },
        reject
      )
      call.end()
    })

  it('is trusted, because the dialer writes the marker and dials loopback', async () => {
    await dialed({ [RELAY_DEVICE_HEADER]: PHONE, [RELAY_DEVICE_NAME_HEADER]: 'iPhone' })
    expect(seen).toEqual({ deviceId: PHONE, name: 'iPhone' })
  })

  it('is NOT trusted from a client that simply reached the same port', async () => {
    await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      headers: { [RELAY_DEVICE_HEADER]: PHONE, [RELAY_DEVICE_NAME_HEADER]: 'iPhone' }
    })
    expect(seen).toBeNull()
  })
})

describe('the admitted-devices row the bridge fills in', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('records a phone the first time it asks, with the name the registry gave', () => {
    let clock = 1000
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    store.record({ deviceId: PHONE, name: 'iPhone' })
    expect(store.list()).toEqual([
      { deviceId: PHONE, name: 'iPhone', admittedAt: 1000, lastSeenAt: 1000 }
    ])
  })

  it('refreshes last-seen without duplicating the phone', () => {
    let clock = 1000
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    store.record({ deviceId: PHONE, name: 'iPhone' })
    clock = 1000 + 10 * 60_000
    store.record({ deviceId: PHONE, name: 'iPhone' })
    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].admittedAt).toBe(1000)
    expect(rows[0].lastSeenAt).toBe(clock)
  })

  it('DOES NOT REWRITE THE FILE ON EVERY REQUEST — a phone polls several times a second', () => {
    let clock = 1000
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    store.record({ deviceId: PHONE, name: 'iPhone' })
    clock += 5
    store.record({ deviceId: PHONE, name: 'iPhone' })
    expect(store.list()[0].lastSeenAt).toBe(1000)
  })

  it('takes a new name at once, whatever the clock says', () => {
    let clock = 1000
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    store.record({ deviceId: PHONE, name: 'iPhone' })
    clock += 5
    store.record({ deviceId: PHONE, name: 'Andrej iPhone' })
    expect(store.list()[0].name).toBe('Andrej iPhone')
  })

  it('keeps the name it had when a request carries none', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: PHONE, name: 'iPhone' })
    store.record({ deviceId: PHONE })
    expect(store.list()[0].name).toBe('iPhone')
  })

  it('KEEPS A PER-DEVICE TOKEN THAT IS ALREADY ON DISK', () => {
    // Nothing mints these any more, but a phone admitted under the old
    // ceremony still holds one — recording a sighting must not revoke it.
    const hash = 'ff'.repeat(32)
    writeAdmittedDevices(
      [{ deviceId: PHONE, name: 'iPhone', admittedAt: 1, lastSeenAt: 1, tokenHash: hash }],
      temp.base
    )
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: PHONE, name: 'Andrej iPhone' })
    expect(store.list()[0]).toMatchObject({ name: 'Andrej iPhone', tokenHash: hash })
    expect(store.accepts('anything')).toBe(false)
  })
})
