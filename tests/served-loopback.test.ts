// NO LOOPBACK FOR A SERVED SEAT BY DEFAULT (owner ruling 2026-11-17). A seat's
// profile is fixed when it starts, so every loopback port is denied, on both
// families, and only what the owner lent the service passes; the gateway, Magpie's
// page and tunnels stay denied even when lent. Run for real in Seatbelt on a Mac.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loopbackAllowClauses, seatbeltProfile } from '../src/main/session-sandbox'
import { readGrant } from '../src/main/service-grants'

const profileFor = (sessions: string, allow: number[], gateway: number[]): string => {
  // POSIX: profile paths are macOS paths, and the text tests also run on Windows.
  const sandbox = path.posix.join(sessions, 'svc', 'sess')
  return seatbeltProfile({ sandbox, siblingRoot: path.posix.join(sessions, 'svc'), sessionsRoot: sessions, secretPaths: [], gatewayPorts: gateway, loopbackAllow: allow })
}

describe('the profile', () => {
  it('denies the guarded ports, then every loopback port, then lets the lent ones through; a guarded port is never lent', () => {
    const text = profileFor('/s', [5173, 3425, 13425], [3425, 13425])
    const gateway = text.indexOf('(deny network-outbound (remote ip "*:3425"))')
    const deny = text.indexOf('(deny network-outbound (remote ip4 "localhost:*"))')
    const lent = text.indexOf('(allow network-outbound (remote ip4 "localhost:5173"))')
    expect(gateway).toBeGreaterThan(text.indexOf('(allow network*)'))
    expect(deny).toBeGreaterThan(gateway)
    expect(lent).toBeGreaterThan(deny)
    const unixDeny = text.indexOf('(deny network-outbound (subpath "/"))')
    const unixAllow = text.indexOf('(allow network-outbound (subpath "/s/svc/sess"))')
    const resolver = text.indexOf('(allow network-outbound (literal "/private/var/run/mDNSResponder"))')
    // IPv6 loopback only: the blanket IPv6 deny is deferred (owner, 2026-11-19).
    const ipv6Deny = text.indexOf('(deny network-outbound (remote ip6 "localhost:*"))')
    expect(text).not.toContain('(remote ip6 "*:*")')
    expect(unixDeny).toBeGreaterThan(text.indexOf('(allow network*)'))
    expect(unixAllow).toBeGreaterThan(unixDeny)
    expect(resolver).toBeGreaterThan(unixDeny)
    expect(ipv6Deny).toBeGreaterThan(deny)
    expect(lent).toBeGreaterThan(ipv6Deny)
    expect(text).not.toContain('localhost:3425')
    expect(text).not.toContain('localhost:13425')
  })

  it('drops anything that is not a port', () => {
    expect(loopbackAllowClauses([0, 70000, 1.5, 8080, 8080])).toEqual(['(allow network-outbound (remote ip4 "localhost:8080"))'])
    expect(loopbackAllowClauses([3425, 3431, 8080], [3431])).toEqual(['(allow network-outbound (remote ip4 "localhost:8080"))'])
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
  new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end())
    server.once('error', reject)
    server.listen(0, host, () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }))
  })

const dial = (profile: string, host: string, port: number): Promise<string> =>
  new Promise((resolve) => {
    const code = `import socket\ns=socket.socket(socket.AF_INET6 if ':' in '${host}' else socket.AF_INET)\ns.settimeout(3)\ntry:\n    s.connect(('${host}', ${port})); print('OPEN')\nexcept PermissionError: print('DENIED')\nexcept OSError as e: print('ERR', e.errno)\n`
    execFile('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/python3', '-I', '-c', code], { timeout: 15_000 }, (_e, stdout) => resolve(String(stdout).trim()))
  })

describe.runIf(process.platform === 'darwin')('in a real Seatbelt sandbox', () => {
  it('prevents a seat from listening without an explicit bind', async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/sl-'))
    try {
      const sessions = path.join(root, 'sessions')
      mkdirSync(path.join(sessions, 'svc', 'sess'), { recursive: true })
      const file = path.join(root, 'profile.sb')
      writeFileSync(file, profileFor(sessions, [], []))
      for (const family of ['AF_INET', 'AF_INET6']) {
        const result = await new Promise<string>((resolve) => {
          const code = `import socket\ns=socket.socket(socket.${family},socket.SOCK_STREAM)\ntry:\n s.listen(1); print('OPEN')\nexcept PermissionError: print('DENIED')\nexcept OSError as e: print('ERR',e.errno)`
          execFile('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/python3', '-I', '-c', code], { timeout: 15000 }, (_error, stdout) => resolve(String(stdout).trim()))
        })
        expect(result, family).toBe('DENIED')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('prevents a seat from binding an unguarded loopback TCP port', async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/sb-'))
    try {
      const sessions = path.join(root, 'sessions')
      mkdirSync(path.join(sessions, 'svc', 'sess'), { recursive: true })
      const file = path.join(root, 'profile.sb')
      writeFileSync(file, profileFor(sessions, [], []))
      const result = await new Promise<string>((resolve) => {
        const code = `import socket\ns=socket.socket()\ntry:\n s.bind(('127.0.0.1',0)); s.listen(1); print('OPEN')\nexcept PermissionError: print('DENIED')\nexcept OSError as e: print('ERR',e.errno)`
        execFile('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/python3', '-I', '-c', code], { timeout: 15000 }, (_error, stdout) => resolve(String(stdout).trim()))
      })
      expect(result).toBe('DENIED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('receives a reply to an implicitly bound UDP socket on a lent port', async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/su-'))
    const server = dgram.createSocket('udp4')
    server.on('message', (message, peer) => server.send(message, peer.port, peer.address))
    await new Promise<void>((resolve, reject) => server.once('error', reject).bind(0, '127.0.0.1', resolve))
    try {
      const port = server.address().port
      const sessions = path.join(root, 'sessions')
      mkdirSync(path.join(sessions, 'svc', 'sess'), { recursive: true })
      const file = path.join(root, 'profile.sb')
      writeFileSync(file, profileFor(sessions, [port], []))
      const result = await new Promise<string>((resolve) => {
        const code = `import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'udp-response',('127.0.0.1',${port})); print(s.recvfrom(256)[0].decode())`
        execFile('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/python3', '-I', '-c', code], { timeout: 15000 }, (_error, stdout) => resolve(String(stdout).trim()))
      })
      expect(result).toBe('udp-response')
    } finally {
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('reads the response from a lent outgoing TCP connection', async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/sr-'))
    const server = net.createServer((connection) => connection.end('sandbox-response'))
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as net.AddressInfo).port
      const sessions = path.join(root, 'sessions')
      mkdirSync(path.join(sessions, 'svc', 'sess'), { recursive: true })
      const file = path.join(root, 'profile.sb')
      writeFileSync(file, profileFor(sessions, [port], []))
      const result = await new Promise<string>((resolve) => {
        const code = `import socket\ns=socket.socket(); s.settimeout(3); s.connect(('127.0.0.1',${port})); print(s.recv(256).decode())`
        execFile('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/python3', '-I', '-c', code], { timeout: 15000 }, (_error, stdout) => resolve(String(stdout).trim()))
      })
      expect(result).toBe('sandbox-response')
    } finally {
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('denies connections to an external Unix socket, including its /tmp alias', async () => {
    // Keep the path below the Unix-domain socket path-length limit on macOS.
    const root = realpathSync(mkdtempSync('/private/tmp/su-'))
    const socket = path.join(root, 'control.sock')
    const server = net.createServer((connection) => connection.end())
    const internal = net.createServer((connection) => connection.end())
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve))
    try {
      const sessions = path.join(root, 'sessions')
      mkdirSync(path.join(sessions, 'svc', 'sess'), { recursive: true })
      const file = path.join(root, 'profile.sb')
      writeFileSync(file, profileFor(sessions, [], []))
      const internalSocket = path.join(sessions, 'svc', 'sess', 'internal.sock')
      await new Promise<void>((resolve, reject) => internal.once('error', reject).listen(internalSocket, resolve))
      const connect = (target: string): Promise<string> => new Promise((resolve) => {
        const code = `import socket\ns=socket.socket(socket.AF_UNIX)\ntry:\n s.connect(${JSON.stringify(target)}); print('OPEN')\nexcept PermissionError: print('DENIED')\nexcept OSError as e: print('ERR', e.errno)`
        execFile('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/python3', '-I', '-c', code], { timeout: 15000 }, (_error, stdout) => resolve(String(stdout).trim()))
      })
      expect(await connect(socket)).toBe('DENIED')
      expect(await connect(internalSocket)).toBe('OPEN')
      // The system resolver is an exact exception, not an allow for sibling sockets.
      expect(profileFor(sessions, [], [])).toContain('(allow network-outbound (literal "/private/var/run/mDNSResponder"))')
      internal.close()
      if (socket.startsWith('/private/var/')) expect(await connect(socket.replace('/private/var/', '/var/'))).toBe('DENIED')
      if (socket.startsWith('/private/tmp/')) expect(await connect(socket.replace('/private/tmp/', '/tmp/'))).toBe('DENIED')
    } finally {
      server.close()
      if (internal.listening) internal.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('denies loopback on both families, opens the lent port, and keeps a lent gateway port shut; pins the mapped-address gap the owner deferred', async () => {
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
      const control = path.join(root, 'control.sb')
      writeFileSync(control, '(version 1)\n(allow default)\n')
      // Prove mapped addresses actually reach this loopback-only listener without confinement.
      for (const host of ['::ffff:127.0.0.1', '::ffff:0.0.0.0', '::ffff:0:0']) {
        expect(await dial(control, host, v4.port), `control ${host}`).toBe('OPEN')
        // The gateway's deny names the port on any host, so no spelling reaches it.
        expect(await dial(file, host, gateway.port), `guarded ${host}`).toBe('DENIED')
      }
      expect(await dial(file, '::ffff:127.0.0.1', v4.port)).toBe('DENIED')
      expect(await dial(file, '127.0.0.1', v4.port)).toBe('DENIED')
      // KNOWN GAP, deferred by the owner on 2026-11-19 to the next release: the
      // blanket IPv6 deny was left out of the hotfix, so an IPv4-mapped any-address
      // still reaches an IPv4 loopback listener. Pinned so the fix flips it on purpose.
      expect(await dial(file, '::ffff:0.0.0.0', v4.port), 'deferred gap').toBe('OPEN')
      expect(await dial(file, '::ffff:0:0', v4.port), 'deferred gap').toBe('OPEN')
      expect(await dial(file, '::1', v6.port)).toBe('DENIED')
      expect(await dial(file, '127.0.0.1', lent.port)).toBe('OPEN')
      expect(await dial(file, '127.0.0.1', gateway.port)).toBe('DENIED')
    } finally {
      for (const server of [v4, lent, gateway, v6]) server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
