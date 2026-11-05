// THE `cookrew` SHIM ON A MACHINE WITH NO NODE. Round 1 on the Solis box:
// "exec: node: not found". The app already ships a Node: its own Electron, in
// node mode. These run the generated sh for real, with node off the PATH.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OWNED_BINARY, cliWrapper, publishCliRuntime } from '../src/main/cli-shim'
// @ts-expect-error the installer lib ships no types; the test exercises runtime behaviour.
import { OWNED_BINARY as OWNED_BINARY_LAUNCHER, launcherScript } from '../scripts/install-cli-lib.mjs'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-shim-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A PATH holding sh's own tools and no node, checked rather than assumed. */
const NO_NODE_PATH = '/usr/bin:/bin'
const noNodeOnPath = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: NO_NODE_PATH } }).status !== 0

const executable = (file: string, body: string): string => {
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

/** A stand-in for the app binary: says how it was called. */
const fakeRuntime = (dir: string): string =>
  executable(path.join(dir, 'Fake Runtime'), '#!/bin/sh\necho "mode=$ELECTRON_RUN_AS_NODE args=$*"\n')

describe('cliWrapper', () => {
  it('is POSIX sh', () => {
    expect(cliWrapper('/tmp/c.mjs', '/app/Cookrew').startsWith('#!/bin/sh\n')).toBe(true)
  })

  it("runs the script on the app's own binary, in node mode, with no node anywhere", () => {
    const dir = scratch()
    const wrapper = executable(path.join(dir, 'cookrew'), cliWrapper('/tmp/c.mjs', fakeRuntime(dir)))
    const out = execFileSync(wrapper, ['list', '--all'], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' })
    expect(out.trim()).toBe('mode=1 args=/tmp/c.mjs list --all')
  })

  it('survives a path with a space and a quote in it', () => {
    const dir = scratch()
    const runtime = fakeRuntime(dir)
    const script = path.join(dir, "it's here.mjs")
    const wrapper = executable(path.join(dir, 'cookrew'), cliWrapper(script, runtime))
    const out = execFileSync(wrapper, [], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' })
    expect(out.trim()).toBe(`mode=1 args=${script}`)
  })

  it('falls back to a node on PATH when the app binary is gone', () => {
    const dir = scratch()
    executable(path.join(dir, 'node'), '#!/bin/sh\necho "system node $*"\n')
    const wrapper = executable(path.join(dir, 'cookrew'), cliWrapper('/tmp/c.mjs', '/gone/Cookrew'))
    const out = execFileSync(wrapper, ['list'], { env: { PATH: `${dir}:${NO_NODE_PATH}` }, encoding: 'utf8' })
    expect(out.trim()).toBe('system node /tmp/c.mjs list')
  })

  it('does not run a binary at its old path that has become a stranger’s', () => {
    const dir = scratch()
    const planted = path.join(dir, 'planted')
    symlinkSync('/bin/echo', planted)
    executable(path.join(dir, 'node'), '#!/bin/sh\necho "system node $*"\n')
    const wrapper = executable(path.join(dir, 'cookrew'), cliWrapper('/tmp/c.mjs', planted))
    expect(execFileSync(wrapper, ['list'], { env: { PATH: `${dir}:${NO_NODE_PATH}` }, encoding: 'utf8' }).trim()).toBe('system node /tmp/c.mjs list')
  })

  it.skipIf(!noNodeOnPath)('says what to do when there is neither, and does not say "exec: node"', () => {
    const dir = scratch()
    const wrapper = executable(path.join(dir, 'cookrew'), cliWrapper('/tmp/c.mjs', '/gone/Cookrew'))
    const ran = spawnSync(wrapper, [], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' })
    expect(ran.status).toBe(127)
    expect(ran.stderr).toContain('Open Cookrew once')
    expect(ran.stderr).not.toContain('exec: node')
  })
})

describe('publishCliRuntime', () => {
  it('leaves the binary where a shim outside a pane can read it', () => {
    const dir = scratch()
    publishCliRuntime(dir, '/app/Cookrew')
    expect(readFileSync(path.join(dir, 'runtime'), 'utf8')).toBe('/app/Cookrew')
  })
})

describe('the PATH launcher', () => {
  it('keeps the same rule for a binary as the shim', () => {
    expect(OWNED_BINARY_LAUNCHER).toBe(OWNED_BINARY)
  })

  it('prefers the binary the app published, and sets node mode', () => {
    const dir = scratch()
    const repo = executable(path.join(dir, 'cookrew.mjs'), '')
    const pointer = path.join(dir, 'runtime')
    writeFileSync(pointer, fakeRuntime(dir))
    const launcher = executable(path.join(dir, 'cookrew'), launcherScript('/none', repo, '/gone/node', pointer))
    const out = execFileSync(launcher, ['whoami'], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' })
    expect(out.trim()).toBe(`mode=1 args=${repo} whoami`)
  })

  // After an AppImage quits, the pointer names a dead /tmp/.mount_* path anyone can recreate.
  it('takes a published binary only from the caller or root', () => {
    const dir = scratch()
    const repo = executable(path.join(dir, 'cookrew.mjs'), '')
    const pointer = path.join(dir, 'runtime')
    const planted = path.join(dir, 'planted')
    // A link in a dir of mine reads as neither: the nearest a test gets to a stranger's file.
    symlinkSync('/bin/sh', planted)
    writeFileSync(pointer, planted)
    const launcher = executable(path.join(dir, 'cookrew'), launcherScript('/none', repo, fakeRuntime(dir), pointer))
    expect(execFileSync(launcher, [], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' }).trim()).toBe(`mode=1 args=${repo}`)
  })

  it('takes a published binary root owns: an installed app, or an AppImage mount', () => {
    const dir = scratch()
    const repo = executable(path.join(dir, 'cookrew.mjs'), 'exit 0')
    const pointer = path.join(dir, 'runtime')
    writeFileSync(pointer, '/bin/echo')
    const launcher = executable(path.join(dir, 'cookrew'), launcherScript('/none', repo, '/gone/node', pointer))
    expect(execFileSync(launcher, ['hi'], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' }).trim()).toBe(`${repo} hi`)
  })

  it('sets node mode on the baked interpreter too: that may be Electron itself', () => {
    const dir = scratch()
    const repo = executable(path.join(dir, 'cookrew.mjs'), '')
    const launcher = executable(
      path.join(dir, 'cookrew'),
      launcherScript('/none', repo, fakeRuntime(dir), path.join(dir, 'no-pointer'))
    )
    const out = execFileSync(launcher, [], { env: { PATH: NO_NODE_PATH }, encoding: 'utf8' })
    expect(out.trim()).toBe(`mode=1 args=${repo}`)
  })
})

describe('a packaged build keeps node mode', () => {
  it('turns no RunAsNode fuse off: with it off the shim would open a second app', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8')
    expect(builder).not.toMatch(/runAsNode\s*:\s*false/i)
  })
})

describe('the real Electron, with no node on the PATH', () => {
  const electron = (() => {
    try {
      return createRequire(import.meta.url)('electron') as unknown as string
    } catch {
      return ''
    }
  })()
  const CLI = path.resolve('cli/cookrew.mjs')

  const app = async (): Promise<{ socketPath: string; close: () => void }> => {
    const socketPath = path.join(scratch(), 'app.sock')
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const at = buffer.indexOf('\n')
        if (at === -1) return
        const request = JSON.parse(buffer.slice(0, at)) as { id: string; cmd: string }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, output: `heard ${request.cmd}` })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return { socketPath, close: () => server.close() }
  }

  const runs = existsSync(electron) && noNodeOnPath

  it.skipIf(!runs)('carries a command to the app and back', async () => {
    const { socketPath, close } = await app()
    const dir = scratch()
    const wrapper = executable(path.join(dir, 'cookrew'), cliWrapper(CLI, electron))
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(wrapper, ['status'], { env: { PATH: NO_NODE_PATH, COOKREW_SOCKET: socketPath, HOME: dir } })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.on('exit', (code) => resolve({ code, out }))
    })
    close()
    expect(result).toEqual({ code: 0, out: 'heard status\n' })
  })
})

describe('node mode stops at the CLI', () => {
  it('is not handed on to a command run by `secret exec`', async () => {
    // Left in the environment it turns any Electron app the command starts into
    // a bare node, and `cookrew secret exec x -- npm run dev` stops working.
    const socketPath = path.join(scratch(), 'app.sock')
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString().trim()) as { id: string }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, output: 'value' })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          path.resolve('cli/cookrew.mjs'),
          'secret',
          'exec',
          'k',
          '--',
          process.execPath,
          '-e',
          'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))'
        ],
        { env: { ...process.env, COOKREW_SOCKET: socketPath, COOKREW_TERMINAL_ID: 't', ELECTRON_RUN_AS_NODE: '1' } }
      )
      let text = ''
      child.stdout.on('data', (chunk) => (text += chunk))
      child.on('exit', () => resolve(text))
    })
    server.close()
    expect(out).toBe('undefined')
  })
})
