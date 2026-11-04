import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * scripts/verify-mac-release.sh is the gate between a build and a download, and
 * this repo has no Apple certificate, so its PASSING branch cannot be reached
 * with the real tools here. Fake codesign/spctl/xcrun/hdiutil on PATH reach
 * every branch; the real tools were run by hand against a notarized app and an
 * unsigned one (see the lane's report).
 */

const SCRIPT = path.resolve(__dirname, '../scripts/verify-mac-release.sh')
const NOTARIZED = 'accepted\nsource=Notarized Developer ID'

const FAKE_TOOL = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_LOG"
case "$(basename "$0")" in
  codesign) printf '%b' "\${FAKE_CODESIGN_OUTPUT:-}" >&2; exit "\${FAKE_CODESIGN_EXIT:-0}" ;;
  spctl) printf '%s\\n' "\${FAKE_SPCTL_OUTPUT:-}" >&2; exit "\${FAKE_SPCTL_EXIT:-0}" ;;
  xcrun) exit "\${FAKE_STAPLER_EXIT:-0}" ;;
esac
`

const FAKE_HDIUTIL = `#!/bin/sh
echo "hdiutil $*" >> "$FAKE_LOG"
if [ "$1" = attach ]; then
  [ "\${FAKE_ATTACH_EXIT:-0}" = 0 ] || exit "$FAKE_ATTACH_EXIT"
  while [ $# -gt 0 ]; do
    if [ "$1" = -mountpoint ]; then mount="$2"; fi
    shift
  done
  [ -n "\${FAKE_DMG_APP:-}" ] && mkdir -p "$mount/$FAKE_DMG_APP"
  exit 0
fi
if [ "$1" = detach ]; then
  [ "\${FAKE_DETACH_EXIT:-0}" = 0 ] || exit "$FAKE_DETACH_EXIT"
  rm -rf "$2"/*
  exit 0
fi
exit 1
`

describe.skipIf(process.platform === 'win32')('verify-mac-release.sh', () => {
  let dir: string
  let log: string

  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
        FAKE_LOG: log,
        TMPDIR: dir,
        FAKE_SPCTL_OUTPUT: NOTARIZED,
        ...env
      }
    })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'verify-mac-'))
    log = path.join(dir, 'calls.log')
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    for (const tool of ['codesign', 'spctl', 'xcrun']) {
      writeFileSync(path.join(bin, tool), FAKE_TOOL)
      chmodSync(path.join(bin, tool), 0o755)
    }
    writeFileSync(path.join(bin, 'hdiutil'), FAKE_HDIUTIL)
    chmodSync(path.join(bin, 'hdiutil'), 0o755)
    mkdirSync(path.join(dir, 'Cookrew.app'))
    writeFileSync(path.join(dir, 'Cookrew.dmg'), 'not really a disk image')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const app = () => path.join(dir, 'Cookrew.app')
  const dmg = () => path.join(dir, 'Cookrew.dmg')

  describe('its argument', () => {
    it('refuses no argument with a usage line and exit 2', () => {
      const { code, out } = run([])
      expect(code).toBe(2)
      expect(out).toMatch(/usage/i)
    })

    it('refuses a path that does not exist', () => {
      expect(run([path.join(dir, 'Nope.app')]).code).toBe(2)
    })

    it('refuses anything that is not an .app or a .dmg', () => {
      const zip = path.join(dir, 'Cookrew.zip')
      writeFileSync(zip, 'zip')
      expect(run([zip]).code).toBe(2)
    })
  })

  describe('an .app', () => {
    it('passes only when all three checks pass, and runs the exact checks', () => {
      const { code } = run([app()])
      expect(code).toBe(0)
      const seen = calls()
      expect(seen.find((line) => line.startsWith('codesign'))).toContain('--verify --deep --strict')
      expect(seen.find((line) => line.startsWith('spctl'))).toContain('--assess')
      expect(seen.find((line) => line.startsWith('xcrun'))).toContain('stapler validate')
    })

    it('fails when the signature does not verify', () => {
      expect(run([app()], { FAKE_CODESIGN_EXIT: '1' }).code).toBe(1)
    })

    it('fails when Gatekeeper rejects it', () => {
      expect(run([app()], { FAKE_SPCTL_EXIT: '3', FAKE_SPCTL_OUTPUT: 'rejected' }).code).toBe(1)
    })

    it('fails when no ticket is stapled', () => {
      expect(run([app()], { FAKE_STAPLER_EXIT: '65' }).code).toBe(1)
    })

    it('still runs every check after one fails, so one run shows the whole problem', () => {
      const { out } = run([app()], { FAKE_CODESIGN_EXIT: '1', FAKE_STAPLER_EXIT: '65' })
      expect(calls().map((line) => line.split(' ')[0])).toEqual(['codesign', 'spctl', 'xcrun'])
      expect(out).toMatch(/FAIL.*codesign/)
      expect(out).toMatch(/PASS.*spctl/)
      expect(out).toMatch(/FAIL.*stapler/)
    })

    // --verbose prints a line per nested binary, and the reason is the last one:
    // on Chrome that was 40 lines of noise above "detritus not allowed".
    it('shows the end of a long failure, where the reason is', () => {
      const noise = Array.from({ length: 40 }, (_, i) => `--prepared:binary-${i}`).join('\\n')
      const { out } = run([app()], {
        FAKE_CODESIGN_EXIT: '1',
        FAKE_CODESIGN_OUTPUT: `${noise}\\nthe actual reason\\n`
      })
      expect(out).toContain('the actual reason')
      expect(out).not.toContain('binary-0')
    })

    // A Mac with assessments switched off answers "accepted" for anything, so
    // the exit code alone would pass an unsigned app on that machine.
    it('does not take spctl exit 0 as a pass unless the source is a notarized one', () => {
      const off = run([app()], { FAKE_SPCTL_OUTPUT: 'accepted\noverride=security disabled' })
      expect(off.code).toBe(1)
      const unnotarized = run([app()], { FAKE_SPCTL_OUTPUT: 'accepted\nsource=Developer ID' })
      expect(unnotarized.code).toBe(1)
    })
  })

  describe('a .dmg', () => {
    it('mounts it read-only, checks the app inside, and detaches', () => {
      const { code } = run([dmg()], { FAKE_DMG_APP: 'Cookrew.app' })
      expect(code).toBe(0)
      const seen = calls()
      const attach = seen.find((line) => line.startsWith('hdiutil attach')) ?? ''
      expect(attach).toContain('-readonly')
      expect(attach).toContain('-nobrowse')
      expect(seen.find((line) => line.startsWith('codesign'))).toContain('/Cookrew.app')
      expect(seen.some((line) => line.startsWith('hdiutil detach'))).toBe(true)
    })

    it('fails when the app inside fails, and still detaches', () => {
      const { code } = run([dmg()], { FAKE_DMG_APP: 'Cookrew.app', FAKE_STAPLER_EXIT: '65' })
      expect(code).toBe(1)
      expect(calls().some((line) => line.startsWith('hdiutil detach'))).toBe(true)
    })

    // A stuck mount on a release machine is a problem, not a footnote, and the
    // verdict must not read READY over it.
    it('fails when the image will not detach, and says so', () => {
      const { code, out } = run([dmg()], { FAKE_DMG_APP: 'Cookrew.app', FAKE_DETACH_EXIT: '1' })
      expect(code).toBe(1)
      expect(out).toMatch(/FAIL.*detach/)
      expect(out).not.toMatch(/READY: signed/)
    })

    it('fails when the image holds no app', () => {
      expect(run([dmg()]).code).toBe(1)
    })

    it('fails when the image will not mount', () => {
      expect(run([dmg()], { FAKE_ATTACH_EXIT: '1' }).code).toBe(1)
    })
  })
})
