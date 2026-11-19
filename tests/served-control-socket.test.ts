// THE CONTROL SOCKET'S OWN DENY MUST FIRE ON ITS REAL PATH (Seatbelt lane, 2026-11-18).
//
// The app's CLI socket lives under os.tmpdir(), which macOS hands out in its
// /var/folders/... form. Seatbelt matches the RESOLVED path (/private/var/...),
// so a literal written in the /var form never fired: measured, a temp socket
// behind that literal stayed OPEN by either spelling. The profile now names
// both spellings. The blanket Unix-socket deny also covers it; this pins the
// socket's own lines on their own, so neither lock depends on the other.
import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathSpellings, seatbeltProfile } from '../src/main/session-sandbox'

const PROFILE = { sandbox: '/s/svc/ana-1', siblingRoot: '/s/svc', sessionsRoot: '/s', secretPaths: [] }

describe('the spellings of a path', () => {
  it('adds the resolved form for the macOS firmlinks, and keeps the given one', () => {
    expect(pathSpellings('/var/folders/x/T/cookrew-runtime/cookrew.sock', () => null)).toEqual([
      '/var/folders/x/T/cookrew-runtime/cookrew.sock',
      '/private/var/folders/x/T/cookrew-runtime/cookrew.sock'
    ])
    expect(pathSpellings('/tmp/a.sock', () => null)).toEqual(['/tmp/a.sock', '/private/tmp/a.sock'])
    expect(pathSpellings('/private/var/run/x.sock', () => null)).toEqual(['/private/var/run/x.sock', '/var/run/x.sock'])
    expect(pathSpellings('/Users/o/x.sock', () => null)).toEqual(['/Users/o/x.sock'])
  })

  it('adds what the directory resolves to, when it exists', () => {
    expect(pathSpellings('/Users/o/link/x.sock', (dir) => (dir === '/Users/o/link' ? '/Volumes/real' : null))).toEqual([
      '/Users/o/link/x.sock',
      '/Volumes/real/x.sock'
    ])
  })

  it('puts every spelling of the control socket into the profile', () => {
    const text = seatbeltProfile({ ...PROFILE, controlSocketPath: '/var/folders/x/T/cookrew-runtime/cookrew.sock' })
    for (const form of ['/var/folders/x/T/cookrew-runtime/cookrew.sock', '/private/var/folders/x/T/cookrew-runtime/cookrew.sock']) {
      expect(text).toContain(`(deny network-outbound (literal "${form}"))`)
      expect(text).toContain(`(deny file-read* file-write* (literal "${form}"))`)
    }
  })
})

describe.runIf(process.platform === 'darwin')('in a real Seatbelt sandbox', () => {
  it('denies the control socket by either spelling, from its own lines alone', async (ctx) => {
    // os.tmpdir() is the /var/folders form on macOS: the spelling the app uses.
    // A TMPDIR pointed elsewhere cannot show the /var case, so it says nothing.
    if (!os.tmpdir().startsWith('/var/')) return ctx.skip()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-'))
    const socket = path.join(dir, 'c.sock')
    const server = net.createServer((connection) => connection.end())
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve))
    try {
      const own = seatbeltProfile({ ...PROFILE, controlSocketPath: socket })
        .split('\n')
        .filter((line) => line.includes('c.sock'))
      expect(own.length).toBeGreaterThan(0)
      const file = path.join(dir, 'only-the-socket.sb')
      writeFileSync(file, ['(version 1)', '(allow default)', ...own].join('\n'))
      const connect = (target: string): Promise<string> =>
        new Promise((resolve) => {
          const code = `import socket,sys\ns=socket.socket(socket.AF_UNIX)\ntry:\n s.connect(sys.argv[1]); print('OPEN')\nexcept PermissionError: print('DENIED')\nexcept OSError as e: print('ERR', e.errno)`
          execFile('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/python3', '-I', '-c', code, target], { timeout: 15_000 }, (_e, stdout) => resolve(String(stdout).trim()))
        })
      const stat = (target: string): Promise<string> =>
        new Promise((resolve) => {
          execFile('/usr/bin/sandbox-exec', ['-f', file, '/bin/cat', target], { timeout: 15_000 }, (_e, _out, stderr) => resolve(String(stderr)))
        })
      const resolved = path.join(realpathSync(dir), 'c.sock')
      expect(await connect(socket), 'the /var spelling').toBe('DENIED')
      expect(await connect(resolved), 'the /private/var spelling').toBe('DENIED')
      expect(await stat(socket)).toContain('Operation not permitted')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
