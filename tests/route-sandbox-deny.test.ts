// A SEAT CANNOT REACH THE OWNER'S GATEWAY (fix round 1, item 7). The
// served-session Seatbelt profile allows loopback, and magpie takes any key
// from this machine, so the profile must deny the gateway's port outright.
// The text is pinned on every platform; on a Mac the connect itself is
// tried under sandbox-exec against a fake gateway on the denied port.

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gatewayDenyClauses } from '../src/main/route/sandbox-deny'
import { seatbeltProfile } from '../src/main/session-sandbox'

const PROFILE = {
  sandbox: '/s/svc/ana-1',
  siblingRoot: '/s/svc',
  sessionsRoot: '/s',
  secretPaths: ['/home/owner/.ssh']
}

describe('the deny clauses', () => {
  it('name the discovered port and the default, once each, in order', () => {
    expect(gatewayDenyClauses([4100, 3425, 4100])).toEqual([
      '(deny network-outbound (remote ip "*:3425"))',
      '(deny network-outbound (remote ip "*:4100"))'
    ])
    expect(gatewayDenyClauses([])).toEqual(['(deny network-outbound (remote ip "*:3425"))'])
    expect(gatewayDenyClauses([0, 70000, 8080])).toEqual(['(deny network-outbound (remote ip "*:3425"))', '(deny network-outbound (remote ip "*:8080"))'])
  })

  it('sit in the profile AFTER the network allow — last rule wins', () => {
    const p = seatbeltProfile({ ...PROFILE, gatewayPorts: [4100] })
    expect(p).toContain('(deny network-outbound (remote ip "*:3425"))')
    expect(p).toContain('(deny network-outbound (remote ip "*:4100"))')
    expect(p.indexOf('(deny network-outbound (remote ip "*:4100"))')).toBeGreaterThan(p.indexOf('(allow network*)'))
    // Without ports given, the default is still denied: a seat never reaches 3425.
    expect(seatbeltProfile(PROFILE)).toContain('(deny network-outbound (remote ip "*:3425"))')
  })
})

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

describe.skipIf(process.platform !== 'darwin')('under sandbox-exec, on this Mac', () => {
  it('a sandboxed curl cannot connect to the denied port but can to another', async () => {
    const hits: string[] = []
    const serve = async (): Promise<{ port: number; close: () => void }> => {
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '')
        res.end('{"name":"magpie"}')
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      return { port: (server.address() as { port: number }).port, close: () => server.close() }
    }
    const denied = await serve()
    const allowed = await serve()
    cleanup.push(denied.close, allowed.close)
    const dir = mkdtempSync(path.join(tmpdir(), 'route-deny-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const profile = path.join(dir, 'deny.sb')
    writeFileSync(profile, ['(version 1)', '(allow default)', ...gatewayDenyClauses([denied.port])].join('\n'))
    // Async, not execFileSync: the fake gateway lives in THIS process, and a
    // blocking exec would stop it answering — curl then times out (28) for
    // the wrong reason.
    const curl = (port: number): Promise<{ ok: boolean; out: string }> =>
      new Promise((resolve) => {
        execFile('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/curl', '-s', '--max-time', '3', `http://127.0.0.1:${port}/api/hello`], { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => {
          resolve({ ok: error === null, out: String(stdout ?? '') })
        })
      })
    const blocked = await curl(denied.port)
    const open = await curl(allowed.port)
    expect(open.ok).toBe(true)
    expect(open.out).toContain('magpie')
    expect(blocked.out).not.toContain('magpie')
    expect(hits.filter((h) => h === '/api/hello')).toHaveLength(1)
  }, 30_000)
})
