import { spawnSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * WHEN LINUX REFUSES THE SANDBOX, the binary aborts before one line of the app
 * runs: no window, and the reason only on a terminal nobody opened (round 2, bug
 * 13). So the packaged binary goes behind a small sh script, run here for real on
 * every sh this machine has, around a stand-in binary and stand-in system tools.
 */

const hook = createRequire(import.meta.url)('../scripts/linux-launch.cjs') as {
  launchScript: (binary: string, procSys?: string) => string
  wrapBinary: (appOutDir: string, executable: string) => void
}
const afterPack = createRequire(import.meta.url)('../scripts/after-pack-fuses.cjs') as { default: (context: unknown) => Promise<void> }

const SHELLS = ['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell))
/** What Chromium's abort exits with: SIGTRAP. */
const ABORT = 133

describe.each(SHELLS)('the Linux launch under %s', (shell) => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const tool = (dir: string, name: string, body: string): void => {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(path.join(dir, name), 0o755)
  }

  interface Setup {
    userns?: boolean
    helperReady?: boolean
    binary?: string
    dialog?: boolean
    seconds?: number
    procSys?: Record<string, string>
    dirName?: string
  }

  const app = ({ userns = true, helperReady = false, binary = 'exit 0', dialog = true, seconds = 1, procSys = {}, dirName = 'app dir' }: Setup = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew linux-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = path.join(root, dirName)
    const bin = path.join(root, 'bin')
    const home = path.join(root, 'home')
    const proc = path.join(root, 'proc')
    for (const made of [dir, bin, home, proc]) mkdirSync(made)
    tool(dir, 'cookrew', binary)
    writeFileSync(path.join(dir, 'chrome-sandbox'), '')
    hook.wrapBinary(dir, 'cookrew')
    writeFileSync(path.join(dir, 'cookrew'), hook.launchScript('cookrew.bin', proc), { mode: 0o755 })
    for (const [name, value] of Object.entries(procSys)) {
      mkdirSync(path.dirname(path.join(proc, name)), { recursive: true })
      writeFileSync(path.join(proc, name), value)
    }
    tool(bin, 'unshare', `exit ${userns ? 0 : 1}`)
    if (helperReady) tool(bin, 'ls', 'echo "-rwsr-xr-x 1 0 0 100 Jan 1 00:00 $3"')
    if (dialog) tool(bin, 'zenity', `printf '%s\\n' "$@" > "${root}/dialog"; printf '%s' "$LD_LIBRARY_PATH" > "${root}/dialog-libs"`)
    // One tick of the clock per read, `seconds` apart.
    tool(bin, 'date', `n=$(cat "${root}/ticks" 2>/dev/null || echo 0); echo $((n + ${seconds})) > "${root}/ticks"; echo $n`)
    const run = (args: string[] = [], env: Record<string, string> = {}) =>
      spawnSync(shell, [path.join(dir, 'cookrew'), ...args], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, DISPLAY: ':1', ...env }
      })
    const failedFile = path.join(home, '.cookrew', 'launch-failed.txt')
    // Resolved, as the script resolves it: the Mac's tmp is behind a symlink.
    return { root, dir, run, helper: path.join(realpathSync(dir), 'chrome-sandbox'), failedFile, dialogSaid: () => (existsSync(path.join(root, 'dialog')) ? readFileSync(path.join(root, 'dialog'), 'utf8') : null) }
  }

  it('hands a healthy system straight to the binary, with its arguments and its exit', () => {
    const a = app({ binary: 'printf "%s|" "$@"; exit 7' })
    const done = a.run(['one', 'two words'])
    expect(done.stdout).toBe('one|two words|')
    expect(done.status).toBe(7)
    expect(a.dialogSaid()).toBeNull()
    expect(existsSync(a.failedFile)).toBe(false)
  })

  it('becomes the binary there, so nothing stands between the app and its signals', async () => {
    const a = app({ binary: 'echo $$' })
    const child = spawn(shell, [path.join(a.dir, 'cookrew')], { env: { PATH: `${path.join(a.root, 'bin')}:/usr/bin:/bin`, HOME: a.root } })
    const said = await new Promise<string>((resolve) => {
      let out = ''
      child.stdout.on('data', (chunk) => (out += String(chunk)))
      child.on('close', () => resolve(out))
    })
    expect(said.trim()).toBe(String(child.pid))
  })

  it('trusts a helper that root owns with the setuid bit, with no namespaces', () => {
    const a = app({ userns: false, helperReady: true, binary: `exit ${ABORT}` })
    expect(a.run().status).toBe(ABORT)
    expect(a.dialogSaid()).toBeNull()
  })

  it('says why, on screen and on disk, when the binary aborts with neither sandbox', () => {
    const a = app({ userns: false, binary: `echo FATAL >&2; exit ${ABORT}` })
    const done = a.run()
    expect(done.status).toBe(ABORT)
    expect(done.stderr).toContain('FATAL')
    const fix = `sudo chown root:root '${a.helper}' && sudo chmod 4755 '${a.helper}'`
    expect(done.stderr).toContain(fix)
    expect(a.dialogSaid()).toContain(fix)
    expect(readFileSync(a.failedFile, 'utf8')).toContain(fix)
  })

  // AppRun points this at the app's own libraries, which a system dialog must not load.
  it('runs the dialog on the system’s libraries', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}` })
    a.run([], { LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' })
    expect(readFileSync(path.join(a.root, 'dialog-libs'), 'utf8')).toBe('')
  })

  it('tries the next way to say it when a dialog fails', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}`, dialog: false })
    tool(path.join(a.root, 'bin'), 'zenity', 'exit 1')
    tool(path.join(a.root, 'bin'), 'notify-send', `printf '%s\\n' "$@" > "${a.root}/dialog"`)
    a.run()
    expect(a.dialogSaid()).toContain('sandbox')
  })

  // The restriction lets `unshare` through under some profiles, and stops Chromium.
  it('does not take unshare’s word where AppArmor says namespaces are restricted', () => {
    const a = app({ userns: true, binary: `exit ${ABORT}`, procSys: { 'kernel/apparmor_restrict_unprivileged_userns': '1\n' } })
    a.run()
    expect(a.dialogSaid()).toContain('sandbox')
  })

  it('quotes the fix so it can be pasted, whatever the folder is called', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}`, dirName: "it's here" })
    expect(a.run().stderr).toContain(`sudo chmod 4755 '${a.helper.replace("'", "'\\''")}'`)
  })

  it('leaves no old reason lying around once a start gets past the door', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}` })
    a.run()
    expect(existsSync(a.failedFile)).toBe(true)
    writeFileSync(path.join(a.dir, 'cookrew.bin'), '#!/bin/sh\nexit 0\n')
    a.run()
    expect(existsSync(a.failedFile)).toBe(false)
  })

  it('still writes it down with no dialog tool and no display', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}`, dialog: false })
    const done = a.run([], { DISPLAY: '' })
    expect(done.stderr).toContain('sandbox')
    expect(readFileSync(a.failedFile, 'utf8')).toContain('sandbox')
  })

  it('never raises the dialog with no display to put it on', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}` })
    a.run([], { DISPLAY: '' })
    expect(a.dialogSaid()).toBeNull()
  })

  // A squashfs mount is nosuid: chown cannot help, so that line would be a lie.
  it('gives an AppImage the system setting, never a chown it cannot do', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}`, procSys: { 'kernel/apparmor_restrict_unprivileged_userns': '1\n' } })
    const done = a.run([], { APPIMAGE: '/home/x/Cookrew.AppImage' })
    expect(done.stderr).toContain('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')
    expect(done.stderr).not.toContain('chown')
  })

  it('names the older switch where that is the one off', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}`, procSys: { 'kernel/unprivileged_userns_clone': '0\n' } })
    expect(a.run([], { APPIMAGE: '/x.AppImage' }).stderr).toContain('sudo sysctl -w kernel.unprivileged_userns_clone=1')
  })

  it('says what is needed when it knows no switch', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}` })
    const done = a.run([], { APPIMAGE: '/x.AppImage' })
    expect(done.stderr).toContain('user namespaces')
    expect(done.stderr).not.toContain('chown')
  })

  // False alarms cost more than silence: the probe is a guess at what Chromium does.
  it('says nothing if the guess was wrong and the app ran', () => {
    const a = app({ userns: false, binary: 'exit 0' })
    expect(a.run().status).toBe(0)
    expect(a.dialogSaid()).toBeNull()
    expect(existsSync(a.failedFile)).toBe(false)
  })

  it('does not call a crash hours in a refused sandbox', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}`, seconds: 7200 })
    expect(a.run().status).toBe(ABORT)
    expect(a.dialogSaid()).toBeNull()
  })

  it('does not call being told to stop a refused sandbox', () => {
    const a = app({ userns: false, binary: 'exit 143' })
    expect(a.run().status).toBe(143)
    expect(a.dialogSaid()).toBeNull()
  })

  it('does not call an ordinary failure a refused sandbox', () => {
    const a = app({ userns: false, binary: 'exit 1' })
    expect(a.run().status).toBe(1)
    expect(a.dialogSaid()).toBeNull()
  })

  it('stays out of the way of the app’s own Node: the `cookrew` shim runs this binary', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}` })
    a.run([], { ELECTRON_RUN_AS_NODE: '1' })
    expect(a.dialogSaid()).toBeNull()
  })

  it('stays out of the way when the sandbox was turned off on purpose', () => {
    const a = app({ userns: false, binary: `exit ${ABORT}` })
    a.run(['--no-sandbox'])
    expect(a.dialogSaid()).toBeNull()
  })
})

describe('the pack step', () => {
  const unpacked = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-pack-'))
    writeFileSync(path.join(dir, 'cookrew'), 'ELF')
    return dir
  }

  it('puts the script where AppRun looks and the binary beside it', async () => {
    const dir = unpacked()
    await afterPack.default({ electronPlatformName: 'linux', appOutDir: dir, packager: { executableName: 'cookrew' } })
    expect(readFileSync(path.join(dir, 'cookrew.bin'), 'utf8')).toBe('ELF')
    expect(readFileSync(path.join(dir, 'cookrew'), 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
    expect(statSync(path.join(dir, 'cookrew')).mode & 0o111).toBe(0o111)
    rmSync(dir, { recursive: true })
  })

  it('leaves a Windows build alone', async () => {
    const dir = unpacked()
    await afterPack.default({ electronPlatformName: 'win32', appOutDir: dir, packager: { executableName: 'cookrew' } })
    expect(readFileSync(path.join(dir, 'cookrew'), 'utf8')).toBe('ELF')
    rmSync(dir, { recursive: true })
  })
})
