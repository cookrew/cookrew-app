import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * A DESKTOP THE OWNER SAID IS NOT THE SAME (seal-blocked.ts) LEAVES NO LIVE MAGPIE KEY (Relay, landing round).
 *
 * Seal refuses that desktop on every lane, so it can no longer reach this computer's Magpie over the seal.
 * But a key this computer gave it lives on in Magpie itself, capped, and anyone who can reach this Magpie
 * some other way could still spend it. So, when it is blocked and at every launch for every blocked desktop:
 *
 *   B (this computer gave it keys)   every key bound to it is recorded first, then unbound (its streams cut,
 *                                    serve.ts · unbind), then revoked by id through ShareKeys; each is audited.
 *                                    One whose revoke fails stays recorded, is said so, and the next sweep
 *                                    revokes it. A key Magpie no longer lists is gone already.
 *   A (this computer used its Magpie) the remote for it is dropped here, key and provider; nothing is given
 *                                    back, since that desktop is refused on every lane.
 *
 * Idempotent: run again, it finds only what is still recorded.
 */

export const BLOCKED_REVOKES_FILE = 'magpie-blocked-revokes.json'

/** Magpie key ids still to revoke, by the blocked device they were bound to. Ids only, never a key. */
export interface PendingRevokes {
  /** Throws when the file cannot be read. */
  read(): Readonly<Record<string, readonly string[]>>
  write(next: Readonly<Record<string, readonly string[]>>): void
}

export interface BlockedDeps {
  readonly pending: PendingRevokes
  /** The ids of keys this computer gave that device (bound-keys.ts). */
  bound(deviceId: string): readonly string[]
  /** The ids Magpie lists now; null when it cannot be asked. */
  listed(): Promise<readonly string[] | null>
  /** Stop honouring the key here and cut its streams (serve.ts · unbind). */
  unbind(id: string): void
  /** Revoke by id (ShareKeys.revoke, which unbinds again and settles its intent). */
  revoke(id: string): Promise<{ ok: true } | { ok: false; why: string }>
  /** A: drop the remote for that desktop here, key and provider; true when one was there. */
  dropRemote(deviceId: string): Promise<boolean>
  /** The share-keys audit (route/share-audit.ts): names and ids only. */
  audit(line: string): void
}

export interface BlockedResult {
  readonly revoked: readonly string[]
  readonly failed: readonly string[]
  readonly dropped: boolean
}

const short = (deviceId: string): string => `${deviceId.slice(0, 8)}…`

export async function forgetBlockedDesktop(deviceId: string, deps: BlockedDeps): Promise<BlockedResult> {
  let recorded: Readonly<Record<string, readonly string[]>> | null
  try {
    recorded = deps.pending.read()
  } catch {
    recorded = null
  }
  const ids = [...new Set([...safe(() => deps.bound(deviceId), []), ...(recorded?.[deviceId] ?? [])])]
  if (ids.length > 0) {
    // Recorded FIRST: once unbound, the binding is gone, and this record is what a later sweep finds.
    const noted = recorded !== null && tryWrite(deps.pending, { ...recorded, [deviceId]: ids })
    if (!noted) deps.audit(`magpie remote: blocked ${short(deviceId)}: the keys to revoke (${ids.join(', ')}) were not recorded; revoking now`)
  }
  // Every key stops being honoured, and its streams end, before any revoke is asked for.
  for (const id of ids) safe(() => deps.unbind(id), undefined)
  const listed = await deps.listed().catch(() => null)
  const revoked: string[] = []
  const failed: string[] = []
  for (const id of ids) {
    if (listed !== null && !listed.includes(id)) {
      revoked.push(id)
      deps.audit(`magpie remote: blocked ${short(deviceId)}: key ${id} unbound; Magpie lists it no more`)
      continue
    }
    const done = await deps.revoke(id).catch((): { ok: false; why: string } => ({ ok: false, why: 'no answer' }))
    if (done.ok) {
      revoked.push(id)
      deps.audit(`magpie remote: blocked ${short(deviceId)}: key ${id} unbound and revoked`)
    } else {
      failed.push(id)
      deps.audit(`magpie remote: blocked ${short(deviceId)}: key ${id} unbound but not revoked (${done.why}); kept to revoke again at the next launch`)
    }
  }
  if (ids.length > 0) settle(deps.pending, deviceId, failed)
  let dropped = false
  try {
    dropped = await deps.dropRemote(deviceId)
  } catch {
    dropped = false
  }
  if (dropped) deps.audit(`magpie remote: blocked ${short(deviceId)}: its Magpie remote dropped here (key and provider; nothing given back)`)
  return { revoked, failed, dropped }
}

/** The record keeps only what failed; a device with nothing left goes from it. */
function settle(pending: PendingRevokes, deviceId: string, failed: readonly string[]): void {
  try {
    const now = { ...pending.read() }
    if (failed.length === 0) delete now[deviceId]
    else now[deviceId] = failed
    pending.write(now)
  } catch {
    // Left as recorded: the next sweep finds the revoked ones gone from Magpie and drops them then.
  }
}

function tryWrite(pending: PendingRevokes, next: Readonly<Record<string, readonly string[]>>): boolean {
  try {
    pending.write(next)
    return true
  } catch {
    return false
  }
}

function safe<T>(run: () => T, fallback: T): T {
  try {
    return run()
  } catch {
    return fallback
  }
}

/** At launch, for every desktop Seal has blocked (seal-blocked.ts · forgetBlocked): one at a time, past a failure. */
export async function sweepBlocked(ids: readonly string[], forget: (deviceId: string) => Promise<unknown>): Promise<void> {
  for (const id of ids) await forget(id).catch(() => undefined)
}

/**
 * After Seal took the owner's answer (seal-blocked.ts · answerPeer, its `accepted`): NOT THE SAME reaches
 * Magpie too. Returns Seal's answer unchanged.
 */
export function afterPeerAnswer(deviceId: unknown, answer: unknown, accepted: boolean, blocked: (deviceId: string) => Promise<unknown>): boolean {
  if (accepted && answer === 'not-same' && typeof deviceId === 'string') void blocked(deviceId).catch(() => undefined)
  return accepted
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function parse(text: string): Record<string, string[]> {
  const parsed = JSON.parse(text) as { v?: unknown; devices?: unknown }
  if (parsed?.v !== 1 || typeof parsed.devices !== 'object' || parsed.devices === null || Array.isArray(parsed.devices)) throw new Error('The list of keys to revoke is not readable.')
  const out: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  for (const [device, ids] of Object.entries(parsed.devices as Record<string, unknown>)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && ID_RE.test(id))) throw new Error('The list of keys to revoke is not readable.')
    out[device] = ids as string[]
  }
  return out
}

export function filePendingRevokes(file: string): PendingRevokes {
  return {
    read: () => {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'ENOENT') return {}
        throw error
      }
      return parse(text)
    },
    write: (next) => {
      const dir = path.dirname(file)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeSync(fd, `${JSON.stringify({ v: 1, devices: next })}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      if (process.platform === 'win32') return
      const dirFd = openSync(dir, 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    }
  }
}

export function memoryPendingRevokes(): PendingRevokes {
  let held: Record<string, readonly string[]> = {}
  return { read: () => ({ ...held }), write: (next) => void (held = { ...next }) }
}
