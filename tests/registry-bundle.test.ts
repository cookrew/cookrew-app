import { claimThroughSetup } from './support/second-step'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// THE DEPLOYED BUNDLE, not the source: `npm run registry:build`'s own esbuild
// command, built into a temp dir and booted as `node <bundle>`, the way the
// cluster runs it. Full --minify renames identifiers, so this is what proves
// the renamed bundle still serves /me, /me/account, presence and desktops.
// Every account and machine is invented; nothing is written outside the temp dir.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** A ConfigMap holds at most 1 MiB of data. */
const CONFIGMAP_MAX = 1_048_576
/** Fail well before the ceiling: the registry bundle grows with every lane. */
const BUNDLE_BUDGET = 1_000_000
const PASSWORD = 'correct horse battery staple'

let dir = ''
let bundle = ''

/** The esbuild half of registry:build, with only the outfile and the site ref swapped. */
function buildCommand(): string {
  const scripts = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  const build = scripts['registry:build'].split(' && ').at(-1) ?? ''
  expect(build.startsWith('esbuild ')).toBe(true)
  expect(build).toContain('--outfile=/tmp/registry.mjs')
  const esbuild = path.join(path.dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), 'bin', 'esbuild')
  return build
    .replace(/^esbuild /, `"${esbuild}" `)
    .replace('$(git rev-parse HEAD)', 'bundle-test')
    .replace('--outfile=/tmp/registry.mjs', `--outfile="${bundle}"`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

interface Booted {
  origin: string
  stderr: () => string
  stop: () => Promise<void>
}

/** `node <bundle> --port <free> --data <tmp> --dev [extra]`, resolved once it says it is listening. */
async function boot(name: string, extra: string[]): Promise<Booted> {
  const port = await freePort()
  const env = { ...process.env }
  delete env.COOKREW_REGISTRY
  const child: ChildProcess = spawn(process.execPath, [bundle, '--port', String(port), '--data', path.join(dir, name), '--dev', ...extra], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`registry did not start: ${err}`)), 20_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('registry on ')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`registry exited ${code}: ${err}`))
    })
  })
  return {
    origin: `http://127.0.0.1:${port}`,
    stderr: () => err,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      })
  }
}

interface Signed {
  username: string
  id: string
  token: string
}

async function signUp(origin: string): Promise<Signed> {
  const id = randomUUID()
  const username = `bundle${randomUUID().slice(0, 8)}`
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
  // The production build: a new account sets up its second step before its
  // first session (auth UX 2026-11-09), walked here exactly as a page does.
  const { token } = await claimThroughSetup(origin, { username, password: PASSWORD, device: { id, kind: 'desktop', name: 'Invented Mac', jwk } })
  const put = await fetch(`${origin}/v2/me/desktops/${id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Invented Mac', workspaces: [{ id: 'w1', name: 'Alpha' }] })
  })
  expect(put.ok).toBe(true)
  return { username, id, token }
}

const bearer = (who: Signed): Record<string, string> => ({ authorization: `Bearer ${who.token}` })

/** What every mode serves the same: the account page, presence, desktops, the classic canvas prefix. */
function sharedRoutes(up: () => Booted, who: () => Signed): void {
  it('serves /me/account as the account page', async () => {
    const res = await fetch(`${up().origin}/me/account`, { headers: bearer(who()) })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="me-desktops"')
  })

  it('lists the desktop as a FleetMachine row, and presence says the same in one batch', async () => {
    const list = await fetch(`${up().origin}/v2/me/desktops`, { headers: bearer(who()) })
    expect(list.status).toBe(200)
    const rows = (await list.json()) as Array<{ id: string; online: boolean; lastSeenAt: number | null }>
    expect(rows.map((row) => row.id)).toEqual([who().id])
    expect(rows[0]).toMatchObject({ online: false, lastSeenAt: expect.any(Number) })
    const presence = await fetch(`${up().origin}/v2/me/presence`, { headers: bearer(who()) })
    expect(presence.status).toBe(200)
    const body = (await presence.json()) as { online: number; desktops: unknown[] }
    expect(body.online).toBe(0)
    expect(body.desktops).toEqual([{ id: rows[0].id, online: rows[0].online, lastSeenAt: rows[0].lastSeenAt }])
  })

  it('keeps the classic canvas prefix: 503 while the Mac holds no line', async () => {
    const res = await fetch(`${up().origin}/relay/@${who().username}/desktop/${who().id}/`, {
      headers: { cookie: `__Host-cr_session=${who().token}`, accept: 'application/json' }
    })
    expect(res.status).toBe(503)
  })

  // Home is left out: it asks GitHub for the latest release, and a test stays off the network.
  it('sends a signed-out /me to sign in', async () => {
    expect((await fetch(`${up().origin}/me`)).status).toBe(401)
  })
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'registry-bundle-'))
  bundle = path.join(dir, 'registry.mjs')
  execFileSync('/bin/sh', ['-c', buildCommand()], { cwd: ROOT, stdio: 'pipe' })
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('registry:build', () => {
  it('minifies fully, identifiers included', () => {
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['registry:build']).toMatch(/ --minify /)
    expect(scripts['registry:build']).not.toMatch(/--minify-(?:whitespace|syntax)/)
  })

  it('fits one ConfigMap with room to grow', () => {
    const bytes = statSync(bundle).size
    expect(bytes).toBeLessThan(CONFIGMAP_MAX)
    expect(bytes).toBeLessThan(BUNDLE_BUDGET)
  })
})

describe('the minified bundle', () => {
  let up: Booted
  let who: Signed
  beforeAll(async () => {
    up = await boot('plain', [])
    who = await signUp(up.origin)
  }, 30_000)
  afterAll(() => up?.stop())

  it('keeps /me the account page and the front page where it is', async () => {
    const res = await fetch(`${up.origin}/me`, { headers: bearer(who) })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="me-desktops"')
    expect((await fetch(`${up.origin}/`, { headers: bearer(who), redirect: 'manual' })).status).toBe(200)
    // The front page reads GitHub before it answers, so this waits on the network.
  }, 30_000)

  sharedRoutes(() => up, () => who)
})

// The live deployment's arguments still name the retired shell bundle and its
// mount. They must keep booting until someone tidies the cluster.
describe('the minified bundle under the old deployment arguments', () => {
  let up: Booted
  let who: Signed
  beforeAll(async () => {
    up = await boot('old-args', ['--shell-assets', path.join(dir, 'gone.json')])
    who = await signUp(up.origin)
  }, 30_000)
  afterAll(() => up?.stop())

  it('boots, ignores them, and serves no shell', async () => {
    expect((await fetch(`${up.origin}/me`, { headers: bearer(who) })).status).toBe(200)
    expect((await fetch(`${up.origin}/strata/assets/index-abc123.js`)).status).toBe(404)
  })
})
