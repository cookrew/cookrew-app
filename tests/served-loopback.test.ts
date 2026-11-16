// NO LOOPBACK FOR A SERVED SEAT BY DEFAULT (owner ruling 2026-11-17). A seat's
// profile is fixed when it starts, so every loopback port is denied, on both
// families, and only what the owner lent the service passes; the gateway, Magpie's
// page and tunnels stay denied even when lent. Run for real in Seatbelt on a Mac.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loopbackAllowClauses, seatbeltProfile } from '../src/main/session-sandbox'
import { readGrant } from '../src/main/service-grants'

const profileFor = (sessions: string, allow: number[], gateway: number[]): string => {
  const sandbox = path.join(sessions, 'svc', 'sess')
  return seatbeltProfile({ sandbox, siblingRoot: path.join(sessions, 'svc'), sessionsRoot: sessions, secretPaths: [], gatewayPorts: gateway, loopbackAllow: allow })
}

describe('the profile', () => {
  it('denies the guarded ports, then every loopback port, then lets the lent ones through; a guarded port is never lent', () => {
    const text = profileFor('/s', [5173, 3425, 13425], [3425, 13425])
    const gateway = text.indexOf('(deny network-outbound (remote ip "*:3425"))')
    const deny = text.indexOf('(deny network-outbound (remote ip "localhost:*"))')
    const lent = text.indexOf('(allow network-outbound (remote ip "localhost:5173"))')
    expect(gateway).toBeGreaterThan(text.indexOf('(allow network*)'))
    expect(deny).toBeGreaterThan(gateway)
    expect(lent).toBeGreaterThan(deny)
    expect(text).not.toContain('localhost:3425')
    expect(text).not.toContain('localhost:13425')
  })

  it('drops anything that is not a port', () => {
    expect(loopbackAllowClauses([0, 70000, 1.5, 8080, 8080])).toEqual(['(allow network-outbound (remote ip "localhost:8080"))'])
    expect(loopbackAllowClauses([3425, 3431, 8080], [3431])).toEqual(['(allow network-outbound (remote ip "localhost:8080"))'])
  })
})

describe('a grant’s loopback ports', () => {
  it('are read, and anything that is not a port is named as a problem', () => {
    const reading = readGrant({ svc: { maxSessions: 1, loopbackPorts: [5173, 'x', 0, 5173] } }, 'svc', '/h')
    expect(reading.grant?.loopbackPorts).toEqual([5173])
    expect(reading.problems.join(' ')).toContain('"loopbackPorts" takes port numbers')
    expect(readGrant({ svc: { maxSessions: 1 } }, 'svc', '/h').grant?.loopbackPorts).toEqual([])
  })
})

const listen = (host: string): Promise<{ port: number; close: () => void }> =>
  new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end())
    server.listen(0, host, () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }))
  })

const dial = (profile: string, host: string, port: number): Promise<string> =>
  new Promise((resolve) => {
    const code = `import socket\ns=socket.socket(socket.AF_INET6 if ':' in '${host}' else socket.AF_INET)\ns.settimeout(3)\ntry:\n    s.connect(('${host}', ${port})); print('OPEN')\nexcept PermissionError: print('DENIED')\nexcept OSError as e: print('ERR', e.errno)\n`
    execFile('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/python3', '-I', '-c', code], { timeout: 15_000 }, (_e, stdout) => resolve(String(stdout).trim()))
  })

describe.runIf(process.platform === 'darwin')('in a real Seatbelt sandbox', () => {
  it('denies loopback on both families, opens the lent port, and keeps a lent gateway port shut', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'served-loopback-')))
    const v4 = await listen('127.0.0.1')
    const lent = await listen('127.0.0.1')
    const gateway = await listen('127.0.0.1')
    const v6 = await listen('::1')
    try {
      const sessions = path.join(root, 'sessions')
      mkdirSync(path.join(sessions, 'svc', 'sess'), { recursive: true })
      const file = path.join(root, 'profile.sb')
      writeFileSync(file, profileFor(sessions, [lent.port, gateway.port], [gateway.port]))
      expect(await dial(file, '127.0.0.1', v4.port)).toBe('DENIED')
      expect(await dial(file, '::1', v6.port)).toBe('DENIED')
      expect(await dial(file, '127.0.0.1', lent.port)).toBe('OPEN')
      expect(await dial(file, '127.0.0.1', gateway.port)).toBe('DENIED')
    } finally {
      for (const server of [v4, lent, gateway, v6]) server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
