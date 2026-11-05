import net from 'node:net'
import { linkSync, lstatSync, unlinkSync } from 'node:fs'

/**
 * Taking the CLI socket path without stealing it.
 *
 * The path ($TMPDIR/cookrew-runtime/cookrew.sock) is shared by every Cookrew
 * under the same TMPDIR. A second instance (a QA run with its own userData
 * slips past the single-instance lock) used to unlink the LIVE app's socket
 * on boot, and its exit then removed the path: every `cookrew` command from
 * every agent failed with ENOENT until the main app restarted (2026-09-18).
 *
 * Two rules close it:
 *  - Boot: probe first. Only a socket nobody answers on (ECONNREFUSED) is
 *    removed; anything that answers, or that we cannot read, is left alone
 *    and this instance runs without a CLI socket.
 *  - Shutdown: remove the path only while it still holds the inode we bound.
 *    That includes libuv: a Unix server unlinks its bound path BY NAME on
 *    close (and on exit teardown), so we never bind the shared name at all.
 *    We bind a private staging name and hard-link it into place — link()
 *    fails with EEXIST instead of overwriting a socket that appeared since
 *    the probe — then drop the staging name. libuv's close-time unlink then
 *    hits the gone staging name, never the shared path.
 */

export const PROBE_TIMEOUT_MS = 500

export type ProbeState = 'absent' | 'stale' | 'live' | 'unknown'

export interface SocketProbe {
  state: ProbeState
  /** The errno (or 'timeout') behind an 'unknown' answer. */
  detail?: string
}

export interface SocketClaim {
  /** True when this process serves the path. */
  owned: boolean
  path: string
  /** Why the path was left alone, when it was. */
  reason?: string
  /** Remove the path if, and only if, it still holds our socket. Idempotent. */
  release: () => void
}

/** Ask the path whether anyone is listening, with a short connect. */
export function probeSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<SocketProbe> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath)
    const finish = (probe: SocketProbe): void => {
      clearTimeout(timer)
      client.destroy()
      resolve(probe)
    }
    // No answer is not proof of death (a wedged app, a full backlog): leave it.
    const timer = setTimeout(() => finish({ state: 'unknown', detail: 'timeout' }), timeoutMs)
    client.once('connect', () => finish({ state: 'live' }))
    client.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish({ state: 'absent' })
      else if (error.code === 'ECONNREFUSED') finish({ state: 'stale' })
      else finish({ state: 'unknown', detail: error.code ?? error.message })
    })
  })
}

interface Inode {
  dev: number
  ino: number
}

function inodeAt(at: string): Inode | null {
  try {
    const { dev, ino } = lstatSync(at)
    return { dev, ino }
  } catch {
    return null
  }
}

function sameInode(a: Inode | null, b: Inode | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino
}

/** Unlink `at` only while it is still `expected`; a missing path is fine. */
function unlinkIfStill(at: string, expected: Inode | null): void {
  if (!sameInode(inodeAt(at), expected)) return
  try {
    unlinkSync(at)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function unlinkQuietly(at: string): void {
  try {
    unlinkSync(at)
  } catch {
    // Absent is the goal.
  }
}

function listen(server: net.Server, at: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(at, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeQuietly(server: net.Server): Promise<void> {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))
}

let stagingSeq = 0

const unowned = (socketPath: string, reason: string): SocketClaim => ({
  owned: false,
  path: socketPath,
  reason,
  release: () => undefined
})

/**
 * Make `server` serve `socketPath` unless someone else already does. Never
 * rejects for a path held by another process; rejects only when binding a
 * free path fails outright (the caller logs it, as it always did).
 */
export async function claimSocket(
  server: net.Server,
  socketPath: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<SocketClaim> {
  const before = inodeAt(socketPath)
  const probe = await probeSocket(socketPath, timeoutMs)
  if (probe.state === 'live') return unowned(socketPath, 'another Cookrew answers on it')
  if (probe.state === 'unknown') {
    return unowned(socketPath, `it could not be probed (${probe.detail ?? 'unknown'})`)
  }
  // Stale: remove exactly the file we probed, not one that replaced it since.
  if (probe.state === 'stale') unlinkIfStill(socketPath, before)

  stagingSeq += 1
  const staging = `${socketPath}.${process.pid}-${stagingSeq}`
  unlinkQuietly(staging)
  await listen(server, staging)
  try {
    linkSync(staging, socketPath)
  } catch (error) {
    await closeQuietly(server)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return unowned(socketPath, 'another Cookrew took it while this one booted')
    }
    throw error
  } finally {
    unlinkQuietly(staging)
  }

  let ours = inodeAt(socketPath)
  return {
    owned: true,
    path: socketPath,
    // One shot: once unlinked, a later socket could reuse the inode number.
    release: () => {
      const expected = ours
      ours = null
      unlinkIfStill(socketPath, expected)
    }
  }
}
