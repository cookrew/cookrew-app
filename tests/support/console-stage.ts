import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PASSWORD, bearer, bootAuthSite, desktopDevice, Client, type AuthSite, type Device } from './auth-site-harness'
import { startFixtureMachine, type FixtureMachine } from './console-machine'
import { startPagesHost, type PagesHost } from './pages-host'
import { PROFILE } from '../fleet-fixture'

/**
 * THE WHOLE OF COOKREW'S WEB SIDE ON LOOPBACK, for the console's acceptance in
 * a real browser:
 *
 *   the registry      split over its two hosts on one port (auth.localhost,
 *                     api.localhost), naming the console's origin
 *   the console       built for that registry, on a stand-in for its static
 *                     host (pages-host.ts) at console.localhost on another port
 *   one account       with a password and three machines, each holding its
 *                     line to the registry (console-machine.ts); one of them
 *                     says it runs a build older than the console speaks to
 *
 * Nothing here leaves the machine it runs on, and nothing is a production
 * name. The registry's clock can be moved forward (`clock.advance`), which is
 * how a suite lets a fifteen-minute session end without waiting for it.
 */

export const USERNAME = 'acceptance'
export const OLD_VERSION = '0.5.8'
export const NEW_VERSION = '0.6.0'

export interface ConsoleBuild {
  readonly dir: string
  /** The twelve hex digits the page, its worker and version.json all name. */
  readonly id: string
}

export interface ConsoleStage {
  readonly site: AuthSite
  readonly host: PagesHost
  readonly username: string
  readonly password: string
  /** Two machines on a build the console speaks to, and one on an older build. */
  readonly studio: FixtureMachine
  readonly laptop: FixtureMachine
  readonly old: FixtureMachine
  /** The build the host serves at first, and the next one (`host.deploy(next.dir)`). */
  readonly first: ConsoleBuild
  readonly next: ConsoleBuild
  readonly clock: { advance(ms: number): void; offset(): number }
  /**
   * The person, at the first machine: a sign-in from a browser the account has
   * not seen waits there, and is let through when they type the number that
   * browser shows. Answers false while no sign-in is waiting.
   */
  approveSignIn(match: string): Promise<boolean>
  close(): Promise<void>
}

const root = path.resolve(__dirname, '..', '..')

function build(out: string, origins: { api: string; auth: string }, config: string): ConsoleBuild {
  // Found the way node finds it: a linked worktree has no node_modules of its own.
  const vite = path.join(path.dirname(createRequire(__filename).resolve('vite/package.json')), 'bin', 'vite.js')
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COOKREW_')))
  const done = spawnSync(process.execPath, [vite, 'build', '-c', config, '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: root,
    env: { ...clean, COOKREW_CONSOLE_LOCAL: '1', COOKREW_API_ORIGIN: origins.api, COOKREW_AUTH_ORIGIN: origins.auth, COOKREW_CONSOLE_VERSION: NEW_VERSION },
    encoding: 'utf8',
    timeout: 240_000
  })
  if (done.status !== 0) throw new Error(`the console did not build (${config}): ${done.stdout}${done.stderr}`)
  const version = JSON.parse(readFileSync(path.join(out, 'version.json'), 'utf8')) as { build: string }
  return { dir: out, id: version.build }
}

async function joined(site: AuthSite, owner: string, device: Device): Promise<string> {
  const api = new Client(site, 'enrol')
  const minted = await api.call(site.API, 'POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner))
  if (minted.status !== 201) throw new Error(`no join code: ${minted.status} ${minted.text}`)
  const taken = await api.call(site.API, 'POST', '/v2/join', { code: minted.body.code, device: device.payload })
  if (taken.status !== 201) throw new Error(`the machine did not join: ${taken.status} ${taken.text}`)
  return String(taken.body.token)
}

async function described(site: AuthSite, token: string, device: Device, appVersion: string): Promise<void> {
  const put = await new Client(site, 'summary').call(
    site.API,
    'PUT',
    `/v2/me/desktops/${device.payload.id}`,
    { name: device.payload.name, workspaces: [{ id: 'w-kitchen', name: 'Kitchen' }, { id: 'w-garden', name: 'Garden' }], appVersion, profile: PROFILE },
    bearer(token)
  )
  if (put.status >= 300) throw new Error(`the registry did not take ${device.payload.name}'s summary: ${put.status} ${put.text}`)
}

export async function bootConsoleStage(): Promise<ConsoleStage> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'cookrew-console-stage-'))
  const undo: (() => Promise<void> | void)[] = [() => rmSync(scratch, { recursive: true, force: true })]
  const close = async (): Promise<void> => {
    for (const step of undo.reverse()) await Promise.resolve(step()).catch(() => undefined)
    undo.length = 0
  }
  try {
    // The host first: the registry has to be told the console's origin, and the build the registry's.
    const placeholder = path.join(scratch, 'empty')
    mkdirSync(placeholder)
    writeFileSync(path.join(placeholder, 'index.html'), '<!doctype html><title>not deployed yet</title>')
    const host = await startPagesHost(placeholder)
    undo.push(() => host.close())

    let offset = 0
    const now = (): number => Date.now() + offset
    const site = await bootAuthSite({ split: true, secondStep: 'legacy', consoleOrigin: host.origin, now })
    undo.push(() => site.close())

    const origins = { api: site.API, auth: site.A }
    const first = build(path.join(scratch, 'console-1'), origins, 'vite.console.config.ts')
    const next = build(path.join(scratch, 'console-2'), origins, 'tests/support/console-next-build.config.ts')
    if (first.id === next.id) throw new Error('the two builds are the same build')
    host.deploy(first.dir)

    // One account, three machines.
    const devices = { studio: desktopDevice('Studio Mac'), laptop: desktopDevice('Road Laptop'), old: desktopDevice('Attic Mac') }
    const made = await new Client(site, 'owner').call(site.API, 'POST', '/v2/accounts', { username: USERNAME, password: PASSWORD, device: devices.studio.payload })
    if (made.status !== 201) throw new Error(`no account: ${made.status} ${made.text}`)
    const tokens = { studio: String((made.body.session as { token: string }).token), laptop: '', old: '' }
    tokens.laptop = await joined(site, tokens.studio, devices.laptop)
    tokens.old = await joined(site, tokens.studio, devices.old)
    await described(site, tokens.studio, devices.studio, NEW_VERSION)
    await described(site, tokens.laptop, devices.laptop, NEW_VERSION)
    await described(site, tokens.old, devices.old, OLD_VERSION)

    const machine = async (which: keyof typeof devices, appVersion: string): Promise<FixtureMachine> => {
      const started = await startFixtureMachine({ registry: site.API, username: USERNAME, deviceId: devices[which].payload.id, name: devices[which].payload.name, appVersion, token: tokens[which], now })
      undo.push(() => started.close())
      await started.online()
      return started
    }
    const studio = await machine('studio', NEW_VERSION)
    const laptop = await machine('laptop', NEW_VERSION)
    const old = await machine('old', OLD_VERSION)

    return {
      site,
      host,
      username: USERNAME,
      password: PASSWORD,
      studio,
      laptop,
      old,
      first,
      next,
      clock: { advance: (ms) => void (offset += ms), offset: () => offset },
      approveSignIn: async (match) => {
        const desk = new Client(site, 'studio-approves')
        const waiting = await desk.call(site.API, 'GET', '/v2/me/approvals', undefined, bearer(tokens.studio))
        const rows = (Array.isArray(waiting.body) ? waiting.body : []) as { id: string }[]
        if (waiting.status !== 200 || rows.length === 0) return false
        const decided = await desk.call(site.API, 'POST', `/v2/me/approvals/${rows[0].id}`, { decision: 'approve', match }, bearer(tokens.studio))
        if (decided.status !== 204) throw new Error(`the first machine could not approve the sign-in: ${decided.status} ${decided.text}`)
        return true
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
