import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { renderToStaticMarkup } from 'react-dom/server'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { createTelemetry, startTelemetry, stopTelemetry } from '../src/main/telemetry'
import { RELAY_MARKER } from '../src/main/relay-base'
import { TelemetryRowView } from '../src/renderer/src/TelemetryRow'
import { TELEMETRY_ROW_NOTE } from '../src/shared/funnel-events'
import { createDemoApi } from '../src/renderer/src/demo-api'

/**
 * WHERE THE EVENTS FIRE. A call site nobody tests is a funnel step that reads
 * zero and looks like a drop-off.
 */

const TOKEN = 'pairing-token-123'

let base = ''
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'telemetry-wiring-'))
  startTelemetry({ appVersion: '0.4.0', base, env: {}, platform: 'darwin', fetch: async () => new Response(null, { status: 204 }) })
})
afterEach(() => {
  stopTelemetry()
  rmSync(base, { recursive: true, force: true })
})

const events = (): Record<string, unknown> => {
  try {
    return (JSON.parse(readFileSync(path.join(base, 'telemetry.json'), 'utf8')) as { events: Record<string, unknown> }).events
  } catch {
    return {}
  }
}

const ask = async (over: {
  token?: string
  peer?: string
  headers?: Record<string, string>
  pathname?: string
  wallToken?: string
}): Promise<void> => {
  const request = Readable.from([]) as unknown as http.IncomingMessage
  request.method = 'GET'
  request.headers = { ...(over.token ? { authorization: `Bearer ${over.token}` } : {}), ...over.headers }
  Object.defineProperty(request, 'socket', { value: { remoteAddress: over.peer } })
  const response = { writeHead: () => response, end: () => undefined } as unknown as http.ServerResponse
  const deps = { pairingToken: TOKEN, ...(over.wallToken ? { wallToken: over.wallToken } : {}) } as unknown as MobileApiDeps
  await handleMobileApi(request, response, new URL(`http://mac${over.pathname ?? '/api/auth/status'}`), deps)
}

describe('phone_paired: the moment a second device speaks with a pairing credential', () => {
  it('fires for a phone on the LAN holding the token', async () => {
    await ask({ token: TOKEN, peer: '192.168.2.40' })
    expect(events().phone_paired).toBeDefined()
  })

  it('fires for a phone down the relay, which arrives on loopback with the marker', async () => {
    await ask({ token: TOKEN, peer: '127.0.0.1', headers: { [RELAY_MARKER]: '1' } })
    expect(events().phone_paired).toBeDefined()
  })

  it('does not fire for this Mac talking to itself', async () => {
    await ask({ token: TOKEN, peer: '127.0.0.1' })
    await ask({ token: TOKEN, peer: '::ffff:127.0.0.1' })
    expect(events().phone_paired).toBeUndefined()
  })

  it('does not fire for a stranger, a wrong token or the read-only wall', async () => {
    await ask({ peer: '192.168.2.40' })
    await ask({ token: 'wrong', peer: '192.168.2.40' })
    await ask({ token: 'wall-token', peer: '192.168.2.40', wallToken: 'wall-token' })
    expect(events().phone_paired).toBeUndefined()
  })

  it('a relay marker off the loopback is a forged header, not a phone', async () => {
    await ask({ peer: '192.168.2.40', headers: { [RELAY_MARKER]: '1' } })
    expect(events().phone_paired).toBeUndefined()
  })
})

describe('the source call sites', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')

  it('asks whether this is a fresh install before the store writes its first file', () => {
    expect(main.indexOf('isFreshInstall()')).toBeGreaterThan(-1)
    expect(main.indexOf('isFreshInstall()')).toBeLessThan(main.indexOf('new WorkspaceStore()'))
  })

  it('installed fires once the app is ready, and only for a fresh install', () => {
    const ready = main.indexOf('app.whenReady().then(')
    const fired = main.indexOf("emit('installed')")
    expect(fired).toBeGreaterThan(ready)
    expect(main.slice(fired - 80, fired)).toMatch(/if \(freshInstall\)/)
  })

  it('paid fires where the money moved, before a caller with no account can return early', () => {
    const paid = main.indexOf('onPaid: (payment) => {')
    const fired = main.indexOf("emit('paid')", paid)
    const early = main.indexOf('if (team === null || username === null', paid)
    expect(paid).toBeGreaterThan(-1)
    expect(fired).toBeGreaterThan(paid)
    expect(fired).toBeLessThan(early)
  })

  it('paid does not fire on the boot drain: a late report is not a second sale', () => {
    const drain = main.indexOf('void seatSettles\n      .drain()')
    expect(drain).toBeGreaterThan(-1)
    expect(main.slice(drain - 200, drain + 300)).not.toContain("emit('paid')")
  })

  it('the row reaches main over two handlers, and the setter takes only a boolean', () => {
    expect(main).toMatch(/ipcMain\.handle\('telemetry:status'/)
    expect(main).toMatch(/ipcMain\.handle\('telemetry:set', \(_e, on: unknown\) =>/)
    expect(main).toMatch(/typeof on === 'boolean'/)
  })

  it('the sender never goes through the session: no cookies ride along', () => {
    expect(readFileSync('src/main/telemetry.ts', 'utf8')).not.toMatch(/from 'electron'/)
  })
})

describe('the ⋯ row', () => {
  const paint = (status: { on: boolean; locked: boolean }): string =>
    renderToStaticMarkup(<TelemetryRowView status={status} onToggle={() => undefined} />)

  it('says what is sent, in the open, not in a tooltip', () => {
    const html = paint({ on: false, locked: false })
    expect(html).toContain('Usage data off')
    expect(html).toContain(TELEMETRY_ROW_NOTE)
    expect(html).toContain('aria-pressed="false"')
  })

  it('on reads on', () => {
    const html = paint({ on: true, locked: false })
    expect(html).toContain('Usage data on')
    expect(html).toContain('aria-pressed="true"')
  })

  it('held off by the environment it cannot be pressed, and says why', () => {
    const html = paint({ on: false, locked: true })
    expect(html).toContain('disabled')
    expect(html).toContain('COOKREW_TELEMETRY=0')
  })

  it('sits in the menu, and only where main can hold the setting', () => {
    const more = readFileSync('src/renderer/src/HeaderMore.tsx', 'utf8')
    expect(more).toContain('<TelemetryRow')
    const row = readFileSync('src/renderer/src/TelemetryRow.tsx', 'utf8')
    expect(row).toMatch(/telemetryStatus/)
    expect(readFileSync('src/renderer/src/remote-api.ts', 'utf8')).not.toContain('telemetryStatus')
  })

  it('the demo answers off and remembers a press', async () => {
    const api = createDemoApi()
    await expect(api.telemetryStatus?.()).resolves.toEqual({ on: false, locked: false })
    await expect(api.setTelemetry?.(true)).resolves.toEqual({ on: true, locked: false })
    await expect(api.telemetryStatus?.()).resolves.toEqual({ on: true, locked: false })
  })
})

describe('never a real home', () => {
  it('a client with a stubbed line never reaches the network', async () => {
    const line = vi.fn(async () => new Response(null, { status: 204 }))
    const telemetry = createTelemetry({ appVersion: '0.4.0', base, env: {}, platform: 'darwin', fetch: line })
    telemetry.emit('paid')
    await telemetry.settled()
    expect(line).not.toHaveBeenCalled()
  })
})
