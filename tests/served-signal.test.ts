// A SEAT SIGNALS ONLY ITS OWN PROCESSES (Seatbelt lane, 2026-11-18).
//
// `(allow signal)` with no filter let a seat kill any process of the owner's:
// the app, the gateway, another seat. Killing a pane is also what makes the
// app respawn it, which is how a seat would choose its moment against the
// profile file (tests/served-profile-swap.test.ts). Signals are now limited to
// processes in the same sandbox; a seat still stops its own children.
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { seatbeltProfile } from '../src/main/session-sandbox'

describe('the profile', () => {
  it('allows signals only to the same sandbox', () => {
    const text = seatbeltProfile({ sandbox: '/s/svc/a', siblingRoot: '/s/svc', sessionsRoot: '/s', secretPaths: [] })
    expect(text).toContain('(allow signal (target same-sandbox))')
    expect(text).not.toMatch(/\(allow [^)]*\bsignal\)/)
  })
})

describe.runIf(process.platform === 'darwin')('in a real Seatbelt sandbox', () => {
  it('cannot signal a process outside, and can still stop its own child', async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/sb-sig-'))
    const outside = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    try {
      const sessions = path.join(root, 'sessions')
      const sandbox = path.join(sessions, 'svc', 'sess')
      mkdirSync(sandbox, { recursive: true })
      const file = path.join(root, 'p.sb')
      writeFileSync(file, seatbeltProfile({ sandbox, siblingRoot: path.join(sessions, 'svc'), sessionsRoot: sessions, secretPaths: [] }))
      const script = `kill -0 ${outside.pid} 2>/dev/null && echo OUTSIDE-REACHED || echo outside-denied; /bin/sleep 30 & c=$!; kill $c && echo own-child-stopped`
      const out = await new Promise<string>((resolve) =>
        execFile('/usr/bin/sandbox-exec', ['-f', file, '/bin/sh', '-c', script], { env: { HOME: sandbox, PATH: '/usr/bin:/bin' }, timeout: 15_000 }, (_e, stdout) => resolve(String(stdout)))
      )
      expect(out).toContain('outside-denied')
      expect(out).toContain('own-child-stopped')
      expect(outside.exitCode).toBe(null)
    } finally {
      outside.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
