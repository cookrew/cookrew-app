// NO SYSTEM SERVICE ACTS FOR A SEAT (Seatbelt lane, 2026-11-18).
//
// Seatbelt's rules bind the confined process only. A service that fetches for
// its client does it from its own unconfined process, so every loopback,
// gateway and IPv6 deny was void for a request handed to it: a background
// URLSession (nsurlsessiond) uploaded to a denied 127.0.0.1 port and read the
// reply. The profile now denies the lookup of each such service
// (seat-mach-denies.ts), and of the pasteboard, which is the owner's data.
//
// The text is pinned on every platform. On a Mac with swiftc, compiled probes run
// the real thing. Each case first runs a CONTROL with no confinement: if this
// machine cannot do the thing at all (a headless runner with no user session),
// the case is skipped, because RED/GREEN would then prove nothing. RED runs the
// same profile with the new denies taken out (what released builds ship); GREEN
// runs the real profile, and the listener must see nothing.
import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FETCHING_SERVICES, FETCHING_XPC_PREFIXES, OWNER_DATA_SERVICES, seatMachDenies } from '../src/main/seat-mach-denies'
import { seatbeltProfile } from '../src/main/session-sandbox'

const PROFILE = { sandbox: '/s/svc/ana-1', siblingRoot: '/s/svc', sessionsRoot: '/s', secretPaths: [] }

describe('the profile', () => {
  it('denies nsurlsessiond under both of its registered names, WebKit by service prefix, and the pasteboard', () => {
    expect(FETCHING_SERVICES).toEqual(['com.apple.nsurlsessiond', 'com.apple.nsurlsessiond-launchondemand'])
    expect(FETCHING_XPC_PREFIXES).toEqual(['com.apple.WebKit.'])
    expect(OWNER_DATA_SERVICES).toContain('com.apple.pasteboard.1')
    const denies = seatMachDenies()
    expect(denies).toContain('(deny mach-lookup (global-name "com.apple.nsurlsessiond"))')
    expect(denies).toContain('(deny mach-lookup (global-name "com.apple.nsurlsessiond-launchondemand"))')
    expect(denies).toContain('(deny mach-lookup (xpc-service-name-prefix "com.apple.WebKit."))')
    expect(denies).toContain('(deny mach-lookup (global-name "com.apple.pasteboard.1"))')
  })

  it('places every deny after the blanket mach-lookup allow: last rule wins', () => {
    const text = seatbeltProfile(PROFILE)
    const allow = text.indexOf('(allow sysctl-read mach-lookup mach-priv-task-port)')
    for (const clause of seatMachDenies()) expect(text.indexOf(clause), clause).toBeGreaterThan(allow)
  })

  it('names each service once, with nothing that could end the string', () => {
    const names = [...FETCHING_SERVICES, ...OWNER_DATA_SERVICES, ...FETCHING_XPC_PREFIXES]
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})

const canProbe = process.platform === 'darwin' && spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0

/** One HTTP listener on loopback that counts every request it is handed. */
interface Listener {
  url: string
  port: number
  hits: () => number
  close: () => Promise<void>
}

const listen = (host: '127.0.0.1' | '::1'): Promise<Listener> =>
  new Promise((resolve, reject) => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits += 1
      req.resume()
      req.on('end', () => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>reached-the-listener</body></html>'))
    })
    server.once('error', reject)
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo
      const shown = host === '::1' ? '[::1]' : host
      resolve({ url: `http://${shown}:${port}/probe`, port, hits: () => hits, close: () => new Promise((done) => server.close(() => done())) })
    })
  })

describe.runIf(canProbe)('in a real Seatbelt sandbox', () => {
  let root = ''
  let sandbox = ''
  let sessions = ''
  let seq = 0
  const bin: Record<string, string> = {}
  /** Why the probes could not be built (a runner without a working Swift toolchain): every case skips. */
  let unbuilt: string | null = null

  beforeAll(() => {
    root = realpathSync(mkdtempSync('/private/tmp/sb-fetch-'))
    for (const name of ['url-session-probe', 'webkit-probe', 'pasteboard-probe']) {
      bin[name] = path.join(root, name)
      const source = path.join(__dirname, 'fixtures', 'seatbelt', `${name}.swift`)
      const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', bin[name], source], { encoding: 'utf8', timeout: 170_000 })
      if (built.status !== 0) {
        unbuilt = `swiftc ${name} failed: ${built.stderr}`
        console.error(`[served-fetch-services] probes skipped: ${unbuilt}`)
        break
      }
    }
    sessions = path.join(root, 'sessions')
    sandbox = path.join(sessions, 'svc', 'sess')
    mkdirSync(sandbox, { recursive: true })
    writeFileSync(path.join(sandbox, 'upload.txt'), 'seat-upload')
  }, 400_000)

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const profileWith = (lent: number[]): string =>
    seatbeltProfile({ sandbox, siblingRoot: path.join(sessions, 'svc'), sessionsRoot: sessions, secretPaths: [], loopbackAllow: lent })

  /** The profile without the lines this lane added: what released builds ship. */
  const withoutTheFix = (profile: string): string =>
    profile
      .split('\n')
      .filter((line) => !seatMachDenies().includes(line))
      .join('\n')

  const write = (name: string, profile: string): string => {
    const file = path.join(root, `${name}-${seq++}.sb`)
    writeFileSync(file, profile)
    return file
  }

  /** Run a probe under `profile` (null = unconfined), HOME in the sandbox; one line back. */
  const run = (profile: string | null, probe: string, args: string[]): Promise<string> =>
    new Promise((resolve) => {
      const [file, argv] = profile ? ['/usr/bin/sandbox-exec', ['-f', profile, bin[probe], ...args]] : [bin[probe], args]
      const env = { HOME: sandbox, TMPDIR: sandbox, PATH: '/usr/bin:/bin' }
      execFile(file, argv, { encoding: 'utf8', timeout: 30_000, env }, (_error, stdout) => resolve(String(stdout).trim().split('\n').pop() ?? ''))
    })

  /** Poll until `done()` holds or the deadline passes: a fixed sleep flakes on a loaded runner. */
  const until = async (done: () => boolean, ms: number): Promise<void> => {
    const end = Date.now() + ms
    while (!done() && Date.now() < end) await new Promise((tick) => setTimeout(tick, 250))
  }

  const upload = (profile: string | null, mode: 'background' | 'ephemeral', url: string): Promise<string> =>
    run(profile, 'url-session-probe', [mode, url, path.join(sandbox, 'upload.txt'), `dev.cookrew.seatbelt-probe.${process.pid}.${seq++}`])

  it('nsurlsessiond: closes the background-session bypass on 127.0.0.1 and ::1', async (ctx) => {
    if (unbuilt) return ctx.skip()
    const v4 = await listen('127.0.0.1')
    const v6 = await listen('::1')
    try {
      const control = await upload(null, 'background', v4.url)
      if (!control.startsWith('OK 200')) return ctx.skip()
      const fixed = write('fixed', profileWith([]))
      const released = write('released', withoutTheFix(profileWith([])))

      // In-process, Seatbelt already denies loopback: the rule the bypass voided.
      expect(await upload(fixed, 'ephemeral', v4.url)).toMatch(/^ERR /)

      for (const target of [v4, v6]) {
        const before = target.hits()
        expect(await upload(released, 'background', target.url), `RED ${target.url}`).toMatch(/^OK 200 .*reached-the-listener/)
        expect(target.hits()).toBe(before + 1)
        const after = target.hits()
        expect(await upload(fixed, 'background', target.url), `GREEN ${target.url}`).not.toMatch(/^OK /)
        expect(target.hits(), `listener hit through nsurlsessiond: ${target.url}`).toBe(after)
      }
    } finally {
      await v4.close()
      await v6.close()
    }
  }, 180_000)

  it('nsurlsessiond: in-process URLSession still works on a lent port; the background path stays shut there too', async (ctx) => {
    if (unbuilt) return ctx.skip()
    const lent = await listen('127.0.0.1')
    try {
      // CONTROL: unconfined, both kinds of session reach it, or nothing below means anything.
      if (!(await upload(null, 'ephemeral', lent.url)).startsWith('OK 200')) return ctx.skip()
      if (!(await upload(null, 'background', lent.url)).startsWith('OK 200')) return ctx.skip()
      const fixed = write('lent', profileWith([lent.port]))
      expect(await upload(fixed, 'ephemeral', lent.url)).toMatch(/^OK 200 .*reached-the-listener/)
      const before = lent.hits()
      expect(await upload(fixed, 'background', lent.url)).not.toMatch(/^OK /)
      expect(lent.hits()).toBe(before)
    } finally {
      await lent.close()
    }
  }, 120_000)

  it('a detached child keeps the profile its seat started under, after the seat is gone (seat-ledger.ts)', async (ctx) => {
    if (unbuilt) return ctx.skip()
    const v4 = await listen('127.0.0.1')
    try {
      if (!(await upload(null, 'background', v4.url)).startsWith('OK 200')) return ctx.skip()
      const detachAndUpload = (profile: string, tag: string): Promise<void> =>
        new Promise((resolve) => {
          const out = path.join(sandbox, `orphan-${tag}.out`)
          const inner = `sleep 2; '${bin['url-session-probe']}' background '${v4.url}' '${path.join(sandbox, 'upload.txt')}' dev.cookrew.orphan.${process.pid}.${tag} > '${out}' 2>&1`
          // The seat's shell starts a detached child and exits at once.
          execFile('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', `nohup /bin/sh -c "${inner}" >/dev/null 2>&1 &`], { env: { HOME: sandbox, PATH: '/usr/bin:/bin' } }, () => resolve())
        })
      const before = v4.hits()
      await detachAndUpload(write('orphan-released', withoutTheFix(profileWith([]))), 'released')
      await detachAndUpload(write('orphan-fixed', profileWith([])), 'fixed')
      // The parents are gone. Wait for the released child to get through, then
      // give the fixed one as long again to prove it never does.
      await until(() => v4.hits() > before, 45_000)
      expect(v4.hits(), 'the child started under the released profile got through').toBe(before + 1)
      await new Promise((done) => setTimeout(done, 4_000))
      expect(v4.hits(), 'the child started under the fixed profile did not').toBe(before + 1)
    } finally {
      await v4.close()
    }
  }, 120_000)

  it('WebKit: its networking process fetches past a loopback deny, and the service deny stops it', async (ctx) => {
    if (unbuilt) return ctx.skip()
    const v4 = await listen('127.0.0.1')
    try {
      const control = await run(null, 'webkit-probe', [v4.url])
      if (!control.startsWith('LOADED')) return ctx.skip()
      // RULE BY ITSELF, on a base that lets WebKit come up: the seat profile's own
      // default-deny base already keeps WebKit down, which would hide the rule.
      const base = ['(version 1)', '(allow default)', '(deny network-outbound (remote ip4 "localhost:*"))', '(deny network-outbound (remote ip6 "*:*"))']
      const loose = write('webkit-loose', base.join('\n'))
      const locked = write('webkit-locked', [...base, ...seatMachDenies()].join('\n'))
      const before = v4.hits()
      expect(await run(loose, 'webkit-probe', [v4.url]), 'RED: past the loopback deny').toBe('LOADED reached-the-listener')
      expect(v4.hits()).toBe(before + 1)
      const after = v4.hits()
      expect(await run(locked, 'webkit-probe', [v4.url]), 'GREEN: rule alone').not.toMatch(/^LOADED/)
      expect(await run(write('webkit-seat', profileWith([])), 'webkit-probe', [v4.url]), 'GREEN: seat profile').not.toMatch(/^LOADED/)
      expect(v4.hits()).toBe(after)
    } finally {
      await v4.close()
    }
  }, 180_000)

  it('pasteboard: a seat cannot read what another process put on a pasteboard', async (ctx) => {
    if (unbuilt) return ctx.skip()
    // A private, named board: the owner's general clipboard is never read or written.
    const board = `dev.cookrew.seatbelt-probe.${process.pid}`
    try {
      if ((await run(null, 'pasteboard-probe', ['write', board, 'owner-copied-this'])) !== 'WROTE') return ctx.skip()
      if ((await run(null, 'pasteboard-probe', ['read', board])) !== 'READ owner-copied-this') return ctx.skip()
      expect(await run(write('pb-released', withoutTheFix(profileWith([]))), 'pasteboard-probe', ['read', board]), 'RED').toBe('READ owner-copied-this')
      expect(await run(write('pb-fixed', profileWith([])), 'pasteboard-probe', ['read', board]), 'GREEN').not.toContain('owner-copied-this')
    } finally {
      await run(null, 'pasteboard-probe', ['release', board])
    }
  }, 120_000)
})
