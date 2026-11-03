import net from 'node:net'
import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimSocket, probeSocket } from '../src/main/socket-claim'
import { startSocketServer } from '../src/main/socket-server'

// Every socket here lives in a fresh temp dir — never the real
// $TMPDIR/cookrew-runtime, which the running app serves the fleet from.
let dir = ''
let sock = ''
const servers: net.Server[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'scl-'))
  sock = path.join(dir, 'cookrew.sock')
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
  rmSync(dir, { recursive: true, force: true })
})

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))
}

function track(server: net.Server): net.Server {
  servers.push(server)
  return server
}

/** A listener that answers on `at`, like the running app's socket. */
async function liveAt(at: string): Promise<net.Server> {
  const server = track(net.createServer((s) => s.end()))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(at, () => resolve())
  })
  return server
}

/**
 * A live listener that ENDS UP at `at` without libuv knowing that name, so
 * closing it never unlinks `at` — the shape of another process's socket.
 */
async function foreignLiveAt(at: string): Promise<net.Server> {
  const staging = `${at}.foreign`
  const server = await liveAt(staging)
  renameSync(staging, at)
  return server
}

/** A socket file nobody listens on: what a crashed app leaves behind. */
async function staleAt(at: string): Promise<void> {
  const server = await foreignLiveAt(at)
  await closeServer(server)
}

function answers(at: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(at)
    client.once('connect', () => {
      client.destroy()
      resolve(true)
    })
    client.once('error', () => resolve(false))
  })
}

describe('probeSocket', () => {
  it('says absent when nothing is at the path', async () => {
    expect((await probeSocket(sock)).state).toBe('absent')
  })

  it('says stale for a socket file nobody listens on', async () => {
    await staleAt(sock)
    expect(existsSync(sock)).toBe(true)
    expect((await probeSocket(sock)).state).toBe('stale')
  })

  it('says live when something answers', async () => {
    await foreignLiveAt(sock)
    expect((await probeSocket(sock)).state).toBe('live')
  })
})

describe('claimSocket — never steal a live socket', () => {
  it('leaves a live socket alone and does not take the path', async () => {
    await foreignLiveAt(sock)
    const before = statSync(sock).ino
    const mine = track(net.createServer())

    const claim = await claimSocket(mine, sock)

    expect(claim.owned).toBe(false)
    expect(mine.listening).toBe(false)
    expect(statSync(sock).ino).toBe(before)
    expect(await answers(sock)).toBe(true)
  })

  it('replaces a stale socket and serves at the path', async () => {
    await staleAt(sock)
    const mine = track(net.createServer((s) => s.end()))

    const claim = await claimSocket(mine, sock)

    expect(claim.owned).toBe(true)
    expect(await answers(sock)).toBe(true)
  })

  it('binds when the path is absent', async () => {
    const mine = track(net.createServer((s) => s.end()))
    const claim = await claimSocket(mine, sock)
    expect(claim.owned).toBe(true)
    expect(await answers(sock)).toBe(true)
  })
})

describe('claimSocket — shutdown removes only what this process made', () => {
  it('release unlinks the path when it still holds our socket', async () => {
    const mine = track(net.createServer())
    const claim = await claimSocket(mine, sock)
    claim.release()
    expect(existsSync(sock)).toBe(false)
  })

  it('release leaves a socket another process put at the path', async () => {
    const mine = track(net.createServer())
    const claim = await claimSocket(mine, sock)
    await foreignLiveAt(sock)

    claim.release()

    expect(await answers(sock)).toBe(true)
  })

  it('closing our server never unlinks a socket another process put at the path', async () => {
    // libuv unlinks a Unix server's path on close (and on exit teardown).
    // Bound naively at the shared path, that close deletes whoever owns it now.
    const mine = track(net.createServer())
    await claimSocket(mine, sock)
    await foreignLiveAt(sock)

    await closeServer(mine)

    expect(await answers(sock)).toBe(true)
  })

  it('a release from an instance that never owned the path is a no-op', async () => {
    await foreignLiveAt(sock)
    const claim = await claimSocket(track(net.createServer()), sock)
    claim.release()
    expect(await answers(sock)).toBe(true)
  })
})

describe('startSocketServer — a second instance boots next to a live app (2026-09-18)', () => {
  it('keeps the live app reachable through the second instance boot AND exit', async () => {
    await foreignLiveAt(sock)
    const deps = { ptys: { socketPath: sock } } as unknown as Parameters<typeof startSocketServer>[0]

    const second = startSocketServer(deps)
    track(second.server)
    const claim = await second.claim

    expect(claim.owned).toBe(false)
    expect(await answers(sock)).toBe(true)

    claim.release()
    await closeServer(second.server)
    expect(await answers(sock)).toBe(true)
  })

  it('serves the CLI when the previous app left a stale socket', async () => {
    await staleAt(sock)
    const deps = { ptys: { socketPath: sock } } as unknown as Parameters<typeof startSocketServer>[0]

    const first = startSocketServer(deps)
    track(first.server)

    expect((await first.claim).owned).toBe(true)
    expect(await answers(sock)).toBe(true)
  })
})
