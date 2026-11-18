// A SEAT CANNOT REWRITE THE PROFILE ITS NEXT SPAWN READS (Seatbelt lane, 2026-11-18).
//
// The profile used to be written inside the seat's own sandbox, which the seat
// may write. sandbox-exec reads it by path a few milliseconds after the app
// writes it, so a live seat process could rename its own `(allow default)` into
// place in between: an independent review measured 19 of 20 respawns running
// unconfined. The profile now lives in an app-only directory outside every
// sandbox, where the seat can neither write nor rename.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionsRootOf } from '../src/main/owner-secrets'
import { sandboxRoot } from '../src/main/session-sandbox'
import { servedConfinement } from '../src/main/session-spawn'

describe.skipIf(process.platform === 'win32')('where the profile is written', () => {
  it('is outside every session sandbox, under the app base', () => {
    const writes: string[] = []
    const out = servedConfinement(
      { base: '/base', serviceId: 'svc', sessionId: 'svc-ana-1', sandbox: '/base/sessions/svc/ana-1', ownerEnv: {} },
      (p) => void writes.push(p)
    )
    expect(writes).toEqual([out.profilePath])
    expect(out.profilePath.startsWith('/base/sessions/')).toBe(false)
    expect(out.profilePath.startsWith('/base/seat-profiles/')).toBe(true)
  })

  it('differs per session, so two sessions never share one file', () => {
    const at = (sessionId: string, sandbox: string): string =>
      servedConfinement({ base: '/base', serviceId: 'svc', sessionId, sandbox, ownerEnv: {} }, () => undefined).profilePath
    expect(at('svc-ana-1', '/base/sessions/svc/ana-1')).not.toBe(at('svc-ana-2', '/base/sessions/svc/ana-2'))
  })
})

describe.runIf(process.platform === 'darwin')('in a real Seatbelt sandbox', () => {
  it('a seat cannot replace or remove the profile its next spawn reads', async () => {
    const base = realpathSync(mkdtempSync('/private/tmp/sb-swap-'))
    try {
      const sandbox = sandboxRoot(base, 'svc', 'svc-ana-1')
      const { profilePath } = servedConfinement({ base, serviceId: 'svc', sessionId: 'svc-ana-1', sandbox, ownerEnv: {} })
      expect(sessionsRootOf(base)).toBe(path.join(base, 'sessions'))
      const before = readFileSync(profilePath, 'utf8')
      // Everything a seat could try: overwrite, rename over it, remove it.
      const attack = [
        `printf '(version 1)\\n(allow default)\\n' > '${sandbox}/evil.sb'`,
        `cp '${sandbox}/evil.sb' '${profilePath}'`,
        `mv '${sandbox}/evil.sb' '${profilePath}'`,
        `rm -f '${profilePath}'`,
        'exit 0'
      ].join('; ')
      await new Promise<void>((resolve) =>
        execFile('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', attack], { env: { HOME: sandbox, PATH: '/usr/bin:/bin' }, timeout: 15_000 }, () => resolve())
      )
      expect(existsSync(profilePath)).toBe(true)
      expect(readFileSync(profilePath, 'utf8')).toBe(before)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)
})
