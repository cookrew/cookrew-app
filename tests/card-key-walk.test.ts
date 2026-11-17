import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signInToDoor } from '../src/main/served-admission'

/**
 * THE CARD'S OWN SIGN-IN AT AN UNLISTED DOOR (resources/orch-line.mjs), run as
 * the real child process against a door that binds, refuses, loses its answer
 * or is busy on demand. It must keep the app's rules (served-admission.ts): a
 * new key saved and proven BEFORE the door sees it, only a 401 is a refusal,
 * kept keys offered again, and the key filed atomically.
 */

const CARD = path.join(__dirname, '..', 'resources', 'orch-line.mjs')
const SERVICE = 'svc-team'
type Verdict = 'bind' | 'refuse' | 'lose' | 'busy'

const homes: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise((done) => server.close(() => done(undefined)))
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const keyDir = (home: string): string => path.join(home, '.cookrew', 'caller-keys')
const filed = (home: string): string => path.join(keyDir(home), `${SERVICE}.json`)
const kept = (home: string): string[] =>
  existsSync(keyDir(home)) ? readdirSync(keyDir(home)).filter((name) => /^svc-team\.json\.pending-[0-9a-f]{8}-[0-9a-f]{12}$/.test(name)) : []
const pubOf = (file: string): string => JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).pub)

/** A TOFU door; `verdict(n)` decides the n-th assert. Records what was on disk as each assert arrived. */
async function tofuDoor(home: string, verdict: (attempt: number) => Verdict = () => 'bind', heldBy: string | null = null) {
  const asserts: Array<{ keptOnDisk: number; jwk: string }> = []
  let bound: string | null = heldBy
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const at = (request.url ?? '').replace(/^\/team/, '')
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (at === '/crew') return send(200, { serviceId: SERVICE })
      if (at === '/api/call/challenge') return send(200, { challenge: 'nonce' })
      if (at === '/api/call/assert') {
        const jwk = JSON.stringify((JSON.parse(raw) as { jwk?: unknown }).jwk ?? null)
        asserts.push({ keptOnDisk: kept(home).length, jwk })
        const said = verdict(asserts.length)
        if (said === 'refuse') return send(401, {})
        if (said === 'busy') return send(503, {})
        bound ??= jwk
        if (jwk !== bound) return send(401, {})
        if (said === 'lose') return request.socket.destroy()
        return send(200, { ok: true, token: 'tok' })
      }
      // The line: never answered, so the card sits after signing in.
      return undefined
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, asserts, bound: () => bound }
}

/** Run the real card once; settle at its first "signed in" or "✕". */
function runCard(origin: string, home: string): Promise<string> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CARD, '--origin', origin, '--slug', 'team', '--sub', 'ana'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const done = (): void => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      settle(out)
    }
    const timer = setTimeout(done, 20_000)
    const watch = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      if (/signed in as|✕/.test(out)) done()
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('exit', done)
  })
}

const freshHome = (): string => {
  const home = mkdtempSync(path.join(tmpdir(), 'card-keys-'))
  homes.push(home)
  return home
}

describe.skipIf(process.platform === 'win32')('the card’s own key, at an unlisted door (POSIX)', () => {
  it('saves and proves a new key BEFORE the door sees it, then files it 0600, atomically', async () => {
    const home = freshHome()
    const door = await tofuDoor(home)
    expect(await runCard(door.origin, home)).toMatch(/signed in as ana/)
    expect(door.asserts.map((a) => a.keptOnDisk)).toEqual([1])
    expect(pubOf(filed(home))).toBe(door.bound())
    expect(statSync(filed(home)).mode & 0o777).toBe(0o600)
    expect(kept(home)).toEqual([])
    expect(readdirSync(keyDir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  }, 30_000)

  it('keeps a key whose answer was LOST, and opens with that key next time', async () => {
    const home = freshHome()
    const door = await tofuDoor(home, (n) => (n === 1 ? 'lose' : 'bind'))
    expect(await runCard(door.origin, home)).toMatch(/✕/)
    expect(kept(home)).toHaveLength(1)
    expect(await runCard(door.origin, home)).toMatch(/signed in as ana/)
    expect(new Set(door.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(pubOf(filed(home))).toBe(door.bound())
  }, 30_000)

  it('a busy door (5xx) refused nothing: the key stays and nothing is minted over it', async () => {
    const home = freshHome()
    const door = await tofuDoor(home, (n) => (n === 1 ? 'busy' : 'bind'))
    expect(await runCard(door.origin, home)).toMatch(/503/)
    expect(await runCard(door.origin, home)).toMatch(/signed in as ana/)
    expect(new Set(door.asserts.map((a) => a.jwk)).size).toBe(1)
  }, 30_000)

  it('a kept key the door may hold survives a forced 401, and no second key is ever made over it', async () => {
    const home = freshHome()
    const door = await tofuDoor(home, (n) => (n === 1 ? 'lose' : n === 2 ? 'refuse' : 'bind'))
    expect(await runCard(door.origin, home)).toMatch(/✕/)
    // A forced 401 (a flooded challenge, say) on the kept key: refused, kept, nothing minted.
    expect(await runCard(door.origin, home)).toMatch(/refused/)
    expect(kept(home)).toHaveLength(1)
    expect(await runCard(door.origin, home)).toMatch(/signed in as ana/)
    expect(new Set(door.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(pubOf(filed(home))).toBe(door.bound())
  }, 45_000)

  it('(a) a door that names a new serviceId and fails its challenge on every sign-in after the first costs ZERO files', async () => {
    const home = freshHome()
    let signIns = 0
    const server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        const at = (request.url ?? '').replace(/^\/team/, '')
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(body))
        }
        if (at === '/crew') {
          signIns += 1
          return send(200, { serviceId: signIns === 1 ? SERVICE : `svc-${Math.random().toString(36).slice(2)}` })
        }
        if (at === '/api/call/challenge') return signIns === 1 ? send(200, { challenge: 'nonce' }) : send(500, {})
        if (at === '/api/call/assert') return send(200, { ok: true, token: 'tok' })
        return undefined
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect(await runCard(origin, home)).toMatch(/signed in as ana/)
    const after = readdirSync(keyDir(home)).sort()
    for (let i = 0; i < 5; i += 1) expect(await runCard(origin, home)).toMatch(/no challenge \(500\)/)
    expect(readdirSync(keyDir(home)).sort()).toEqual(after)
  }, 60_000)

  it('(b) the app meets a forced 401 for the kept key while the card is let in with it: the bound key ends up filed', async () => {
    const home = freshHome()
    // 1: the card's new key is bound, its answer lost. 2: the app's try with it is forced 401. 3: the card's is let in.
    const door = await tofuDoor(home, (n) => (n === 1 ? 'lose' : n === 2 ? 'refuse' : 'bind'))
    expect(await runCard(door.origin, home)).toMatch(/✕/)
    const store = { sub: 'ana', candidates: () => [filed(home)], canonical: () => filed(home) }
    await expect(signInToDoor({ origin: door.origin, slug: 'team' }, store)).rejects.toThrow(/refused/)
    expect(kept(home)).toHaveLength(1)
    expect(await runCard(door.origin, home)).toMatch(/signed in as ana/)
    expect(pubOf(filed(home))).toBe(door.bound())
    expect(new Set(door.asserts.map((a) => a.jwk)).size).toBe(1)
  }, 45_000)
})

describe.skipIf(process.platform === 'win32')('a card started before an update runs the new walk, not the old one', () => {
  it('re-execs itself when its own script or caller-keys.mjs changed on disk, before it signs in again', async () => {
    const home = freshHome()
    // Its own copy of the card, so this test can change it under the running card.
    const bin = mkdtempSync(path.join(tmpdir(), 'card-bin-'))
    homes.push(bin)
    for (const name of ['orch-line.mjs', 'caller-keys.mjs', 'line-guard.mjs']) copyFileSync(path.join(__dirname, '..', 'resources', name), path.join(bin, name))
    let lines = 0
    const server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        const at = (request.url ?? '').replace(/^\/team/, '')
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(body))
        }
        if (at === '/crew') return send(200, { serviceId: SERVICE })
        if (at === '/api/call/challenge') return send(200, { challenge: 'nonce' })
        if (at === '/api/call/assert') return send(200, { ok: true, token: 'tok' })
        if (at.startsWith('/line')) {
          lines += 1
          if (lines === 1) {
            // The app was updated while this card was open; then the door asks it to sign in again.
            appendFileSync(path.join(bin, 'caller-keys.mjs'), '\n// updated\n')
            return send(401, {})
          }
          return undefined
        }
        return send(404, {})
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const child = spawn(process.execPath, [path.join(bin, 'orch-line.mjs'), '--origin', origin, '--slug', 'team', '--sub', 'ana'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    try {
      for (let waited = 0; waited < 20_000 && (out.match(/signed in as ana/g) ?? []).length < 2; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      // The card and the copy it started again: the whole group.
      try {
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        // Gone already.
      }
    }
    expect(out).toMatch(/updated this card; restarting it/)
    // Started again: its banner twice, and signed in twice.
    expect((out.match(/── line →/g) ?? []).length).toBe(2)
    expect((out.match(/signed in as ana/g) ?? []).length).toBe(2)
  }, 30_000)
})

describe('the card’s own key on Windows', () => {
  it('on Windows refuses BEFORE any key is made or shown (nothing there proves its file private); elsewhere signs in', async () => {
    const home = freshHome()
    const door = await tofuDoor(home)
    const out = await runCard(door.origin, home)
    if (process.platform === 'win32') {
      expect(out).toMatch(/not available on Windows/)
      expect(door.asserts).toEqual([])
      expect(kept(home)).toEqual([])
      expect(existsSync(filed(home))).toBe(false)
    } else {
      expect(out).toMatch(/signed in as ana/)
    }
  }, 30_000)
})
