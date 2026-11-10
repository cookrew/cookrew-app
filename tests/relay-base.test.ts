import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relayedRequest } from '../src/main/host-gate'
import { handle, remoteBoot, type MobileServerDeps } from '../src/main/mobile-server'
import { RELAY_MARKER, isLoopbackPeer } from '../src/main/relay-base'
import { takeRelayDevice } from '../src/main/relay-device'

/**
 * A MACHINE SERVES ITS PAGE AT ITS OWN ROOT, AND NOTHING SAYS OTHERWISE (0.6.0).
 *
 * Until 0.6.0 the relay served a machine's page under a prefix and named the
 * prefix in `x-cookrew-base`; the machine believed it from the bridge on
 * loopback and wrote it into the page's boot script. The relay carries no
 * page now. So the boot script names no base, and a request that still names
 * one, from anywhere and however it is marked, is answered exactly as if it
 * had not: nobody on a machine reads that header.
 *
 * What is left of the old rule is the part every other reader of the bridge's
 * marker shares: who counts as loopback.
 */

/** The shape the relay once named a page's prefix in. */
const OLD_BASE = '/relay/@owner/desktop/11111111-2222-3333-4444-555555555555'
const STALE_HEADER = 'x-cookrew-base'
const DEVICE = '22222222-3333-4444-5555-666666666666'

describe('who is on loopback', () => {
  it('reads a dual-stack peer as the loopback it is', () => {
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::ffff:192.168.1.4')).toBe(false)
  })

  it('takes both loopback families, and nobody on a network', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer('192.168.1.44')).toBe(false)
    expect(isLoopbackPeer('100.68.81.64')).toBe(false)
    expect(isLoopbackPeer(undefined)).toBe(false)
  })
})

describe('the boot script of a machine’s own page', () => {
  it('carries no base, with a slug or without one', () => {
    for (const slug of [null, 'playground']) {
      const boot = remoteBoot(slug)
      expect(boot).not.toContain('COOKREW_BASE')
      expect(boot).not.toMatch(/base/i)
      expect(boot).toContain('window.COOKREW_MOBILE = 1')
    }
    expect(remoteBoot(null)).toContain('window.COOKREW_SLUG = ""')
    expect(remoteBoot('playground')).toContain('window.COOKREW_SLUG = "playground"')
  })

  it('takes nothing but the slug: there is no second thing to tell it', () => {
    expect(remoteBoot.length).toBe(1)
  })
})

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

function pageRequest(over: { headers?: Record<string, string>; peer: string }): http.IncomingMessage {
  const request = new EventEmitter() as http.IncomingMessage
  request.method = 'GET'
  request.url = '/'
  request.headers = { host: 'localhost:8639', ...(over.headers ?? {}) }
  Object.assign(request, { socket: { remoteAddress: over.peer } })
  return request
}

function fakeResponse(request: http.IncomingMessage): { response: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const set: Record<string, string> = {}
  const emitter = new EventEmitter()
  const response = Object.assign(emitter, {
    req: request,
    setHeader(name: string, value: string) {
      set[name.toLowerCase()] = value
    },
    getHeader: (name: string) => set[name.toLowerCase()],
    removeHeader(name: string) {
      delete set[name.toLowerCase()]
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status
      captured.headers = { ...set, ...headers }
      return response
    },
    write(chunk: string | Buffer) {
      captured.body += chunk.toString()
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body += chunk.toString()
      emitter.emit('close')
    }
  }) as unknown as http.ServerResponse
  return { response, captured }
}

describe('a request that still names a base', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cookrew-no-base-'))
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A machine with no account: the one kind that serves its page to another device. */
  const deps = (): MobileServerDeps =>
    ({
      multiInstance: () => false,
      store: { focusedId: 'w1' },
      ptys: { get: () => undefined },
      turns: { list: () => [] },
      ops: { listWorkspaces: () => [] },
      presets: [],
      traces: { latestCheckpoint: () => null },
      interactiveBrowserEnabled: () => false,
      pairingToken: 'pairing-token-for-the-page',
      rendererDir: dir
    }) as unknown as MobileServerDeps

  const page = async (over: { headers?: Record<string, string>; peer: string }): Promise<Captured> => {
    const request = pageRequest(over)
    const { response, captured } = fakeResponse(request)
    await handle(request, response, deps())
    return captured
  }

  /** With the bridge's marker and without it, from loopback and from the network. */
  const ARRIVALS: readonly { name: string; marker: boolean; peer: string }[] = [
    { name: 'the bridge, on loopback', marker: true, peer: '127.0.0.1' },
    { name: 'the marker typed on the network', marker: false, peer: '192.168.1.44' },
    { name: 'the marker forged from the network', marker: true, peer: '192.168.1.44' },
    { name: 'loopback with no marker', marker: false, peer: '::ffff:127.0.0.1' }
  ]

  it('gets the page it would have got without one, from wherever it came', async () => {
    for (const arrival of ARRIVALS) {
      const marked: Record<string, string> = arrival.marker ? { [RELAY_MARKER]: '1' } : {}
      const plain = await page({ headers: marked, peer: arrival.peer })
      const named = await page({ headers: { ...marked, [STALE_HEADER]: OLD_BASE }, peer: arrival.peer })
      expect(plain.status, arrival.name).toBe(200)
      expect(plain.body, arrival.name).toContain('window.COOKREW_MOBILE = 1')
      expect(named.status, arrival.name).toBe(plain.status)
      expect(named.body, arrival.name).toBe(plain.body)
      expect(named.headers, arrival.name).toEqual(plain.headers)
      expect(named.body, arrival.name).not.toContain('COOKREW_BASE')
      expect(named.body, arrival.name).not.toContain(OLD_BASE)
    }
  })

  it('cannot put its own words in the page, however the header is spelled', async () => {
    for (const arrival of ARRIVALS) {
      const marked: Record<string, string> = arrival.marker ? { [RELAY_MARKER]: '1' } : {}
      const named = await page({ headers: { ...marked, [STALE_HEADER]: '</script><script>alert(1)//' }, peer: arrival.peer })
      expect(named.body, arrival.name).not.toContain('alert(1)')
    }
  })

  it('is no more the bridge’s, and no less, for naming one', () => {
    for (const arrival of ARRIVALS) {
      const marked: Record<string, string> = arrival.marker ? { [RELAY_MARKER]: '1' } : {}
      const plain = pageRequest({ headers: marked, peer: arrival.peer })
      const named = pageRequest({ headers: { ...marked, [STALE_HEADER]: OLD_BASE }, peer: arrival.peer })
      expect(relayedRequest(named), arrival.name).toBe(relayedRequest(plain))
      expect(relayedRequest(named), arrival.name).toBe(arrival.marker && isLoopbackPeer(arrival.peer))
    }
  })

  it('names no device by it, and the device the bridge named is the same with it', () => {
    for (const arrival of ARRIVALS) {
      const marked: Record<string, string> = arrival.marker ? { [RELAY_MARKER]: '1' } : {}
      const said = { ...marked, 'x-cookrew-device': DEVICE, 'x-cookrew-device-name': 'A phone' }
      const plain = takeRelayDevice(pageRequest({ headers: said, peer: arrival.peer }))
      const named = takeRelayDevice(pageRequest({ headers: { ...said, [STALE_HEADER]: OLD_BASE }, peer: arrival.peer }))
      expect(named, arrival.name).toEqual(plain)
      // Only the bridge on loopback names a device, as before.
      expect(named === null, arrival.name).toBe(!(arrival.marker && isLoopbackPeer(arrival.peer)))
      expect(takeRelayDevice(pageRequest({ headers: { ...marked, [STALE_HEADER]: OLD_BASE }, peer: arrival.peer })), arrival.name).toBeNull()
    }
  })
})
