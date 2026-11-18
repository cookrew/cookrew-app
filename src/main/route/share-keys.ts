import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MAGPIE_PORT, privateHost, tailnetHost } from '../../shared/remote-magpie'
import type { ShareIssueAnswer, SharedKey, ShareWhere } from '../../shared/share-devices'
import type { DiscoveryEnv } from './discovery'

/**
 * SHARING THIS COMPUTER'S MAGPIE WITH THE OWNER'S OTHER DEVICES.
 *
 * One gateway key per device, made by Magpie itself (`gateway-key add` prints a
 * key it made; it refuses one of ours that looks like its own). The key comes
 * back on stdout and is never put on a command line, where `ps` would show it.
 * Each key is held to a daily cost cap and a concurrency cap, by the id Magpie
 * gave it (both verbs take an id, not a name: magpie 0.1.3935). A cap that could
 * not be set takes the key back, so no uncapped key is ever left behind.
 *
 * Only keys this module made are listed or revoked: their names start with
 * `device-`. Keys the owner made by hand in Magpie (`solis-compare`) are theirs.
 *
 * The key is handed to the owner's window once, to copy to the other device.
 * These calls are owner-only IPC and never a companion or relay route.
 */

export const DEVICE_PREFIX = 'device-'
export const DEVICE_CONCURRENCY = 8
export const DAILY_USD_MIN = 1
export const DAILY_USD_MAX = 1000
const KEY_RE = /^sk-magpie-[A-Za-z0-9_-]{16,256}$/
const ID_RE = /^[A-Za-z0-9]{8,64}$/
const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const DEVICE_NAME_RE = /^device-[a-z0-9][a-z0-9-]{0,31}$/

export interface MagpieAnswer {
  code: number
  stdout: string
  stderr: string
}

export type MagpieRun = (args: string[]) => Promise<MagpieAnswer>

export interface KeyRow {
  id: string
  name: string
  limit: string | null
}

/** Magpie's `gateway-key list` table: columns are two or more spaces apart. */
export function parseKeyTable(text: string): KeyRow[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const columns = ['ID', 'NAME', 'STATE', 'GATEWAY KEY', 'LIMIT', 'MODELS', 'ACCOUNTS', 'ACCESS']
  if (!text.endsWith('\n') || lines.length === 0 || lines[0].trim().split(/\s{2,}/).join('|') !== columns.join('|')) {
    throw new Error('Magpie returned an unrecognized gateway key list.')
  }
  // A complete-looking text table is not proof that output was not truncated at a row boundary.
  return lines.slice(1).map((line) => {
    const cells = line.trim().split(/\s{2,}/)
    // An unreadable row cannot safely be mistaken for an empty list during recovery.
    if (cells.length !== 8) throw new Error('Magpie returned an unreadable gateway key row.')
    const [id, name, , , limit] = cells
    if (!ID_RE.test(id)) throw new Error('Magpie returned an invalid gateway key ID.')
    return { id, name, limit: limit && limit !== '-' ? limit : null }
  })
}

export function deviceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
}

const refusal = (why: string): ShareIssueAnswer => ({ ok: false, why })

export class ShareKeys {
  constructor(private readonly deps: { run: MagpieRun }) {}

  private async rows(): Promise<KeyRow[]> {
    const answer = await this.deps.run(['gateway-key', 'list'])
    if (answer.code !== 0) throw new Error(firstLine(answer.stderr) ?? 'Magpie did not list its keys.')
    return parseKeyTable(answer.stdout)
  }

  async list(): Promise<SharedKey[]> {
    return (await this.rows()).filter((row) => DEVICE_NAME_RE.test(row.name)).map((row) => ({ ...row, device: row.name.slice(DEVICE_PREFIX.length) }))
  }

  /** One issue at a time: Magpie allows two keys of one name, so a race could hand out an uncapped key. */
  private queue: Promise<unknown> = Promise.resolve()

  issue(input: { device: unknown; dailyUsd: unknown }, permitted: () => boolean = () => true): Promise<ShareIssueAnswer> {
    const next = this.queue.then(() => this.issueNow(input, permitted))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async issueNow(input: { device: unknown; dailyUsd: unknown }, permitted: () => boolean): Promise<ShareIssueAnswer> {
    const device = deviceSlug(typeof input.device === 'string' ? input.device : '')
    if (!DEVICE_RE.test(device)) return refusal('Name the device, such as “laptop”.')
    const daily = typeof input.dailyUsd === 'number' && Number.isFinite(input.dailyUsd) ? Math.round(input.dailyUsd * 100) / 100 : NaN
    if (!(daily >= DAILY_USD_MIN && daily <= DAILY_USD_MAX)) return refusal(`Set a daily cap between $${DAILY_USD_MIN} and $${DAILY_USD_MAX}.`)
    const name = `${DEVICE_PREFIX}${device}`
    const before = await this.rows()
    if (before.some((row) => row.name === name)) return refusal(`“${device}” already has a key. Revoke it first to make a new one.`)
    if (!permitted()) return refusal('Magpie sharing was switched off.')
    // From here on, a key may exist even if the runner throws before returning.
    let made: string | null = null
    try {
      const added = await this.deps.run(['gateway-key', 'add', name])
      const fresh = await this.freshIds(name, before)
      if (fresh.length > 1) return refusal(`Magpie lists multiple new keys named “${name}” (${fresh.join(', ')}); inspect and revoke them in Magpie.`)
      const key = added.stdout.trim()
      if (added.code !== 0 || !KEY_RE.test(key)) {
        const why = firstLine(added.stderr) ?? 'Magpie did not return a usable key.'
        return refusal(`${why} Magpie may have made a key named “${name}”; check its Gateway keys. No unidentified key was removed.`)
      }
      made = fresh[0] ?? null
      if (made === null) return refusal('Magpie made a key it does not list as new. Check Magpie’s Gateway keys and revoke it there.')
      const capped = await this.capped(made, daily)
      if (capped !== null) return await this.takeBack(made, capped)
      if (!permitted()) return await this.takeBack(made, 'Magpie sharing was switched off.')
      const shared = { id: made, name, device, limit: `$${daily} per day` }
      made = null
      return { ok: true, key, shared }
    } catch (error) {
      // The id may never have been learned: one more look for it, so the key does not stay behind.
      const why = error instanceof Error ? error.message : 'Magpie did not answer.'
      if (made !== null) return await this.takeBack(made, why)
      const late = await this.freshIds(name, before).catch(() => null)
      if (late && late.length > 1) return refusal(`Magpie lists multiple new keys named “${name}” (${late.join(', ')}); inspect and revoke them in Magpie.`)
      if (!late || late.length === 0) return refusal(`${why} Magpie may have made a key named “${name}”; check its Gateway keys.`)
      return refusal(`${why} Magpie may have made a key named “${name}” (${late[0]}); check its Gateway keys. No unidentified key was removed.`)
    }
  }

  private async freshIds(name: string, before: readonly KeyRow[]): Promise<string[]> {
    const known = new Set(before.map((row) => row.id))
    return (await this.rows()).filter((row) => row.name === name && !known.has(row.id)).map((row) => row.id)
  }

  /** Take back a key that was made but not handed over, and say so if even that failed. */
  private async takeBack(id: string | null, why: string): Promise<ShareIssueAnswer> {
    if (id === null) return refusal(why)
    const undone = await this.deps.run(['gateway-key', 'remove', id]).catch(() => null)
    return undone?.code === 0 ? refusal(why) : refusal(`${why} The key it made could not be taken back: revoke “${id}” in Magpie.`)
  }

  private async capped(id: string, daily: number): Promise<string | null> {
    const limit = await this.deps.run(['gateway-key', 'limit', id, 'add', 'day', '--cost', String(daily)])
    if (limit.code !== 0) return firstLine(limit.stderr) ?? 'Magpie did not set the daily cap.'
    const concurrency = await this.deps.run(['gateway-key', 'concurrency', id, String(DEVICE_CONCURRENCY)])
    if (concurrency.code !== 0) return firstLine(concurrency.stderr) ?? 'Magpie did not set the concurrency cap.'
    return null
  }

  async revoke(id: unknown): Promise<{ ok: true } | { ok: false; why: string }> {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, why: 'No such key.' }
    const mine = (await this.list()).some((row) => row.id === id)
    if (!mine) return { ok: false, why: 'Only a key made here for a device can be revoked here.' }
    const removed = await this.deps.run(['gateway-key', 'remove', id])
    return removed.code === 0 ? { ok: true } : { ok: false, why: firstLine(removed.stderr) ?? 'Magpie did not remove the key.' }
  }
}

function firstLine(text: string): string | null {
  // Magpie logs its plugin host's start on stderr with a date; the error is the line after.
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^\d{4}\/\d{2}\/\d{2} /.test(l))
  return line === undefined ? null : line.replace(/^magpie:\s*/, '').slice(0, 200)
}

/** Magpie answers other computers only when its gateway listens beyond loopback (Magpie Settings › Gateway). */
export function gatewayOnNetwork(addr: string | null): boolean {
  if (addr === null) return false
  const host = addr.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return !(host === '127.0.0.1' || host === 'localhost' || host === '::1')
}

interface InterfaceAddress {
  address: string
  family: string | number
  internal: boolean
}

/**
 * This computer's LAN and tailnet addresses, as another device types them. Plain http
 * only on a tailnet, where WireGuard is under it (owner ruling 2026-11-17); a LAN
 * address is given as https, which Magpie serves once https is on there.
 */
export function shareUrls(interfaces: Record<string, readonly InterfaceAddress[] | undefined>, port: number): string[] {
  return Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal && privateHost(a.address))
    .map((a) => `${tailnetHost(a.address) ? 'http' : 'https'}://${a.address}:${port}`)
}

/** Where Magpie wrote down that it listens (`magpie status`), or null. */
export function gatewayAddr(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string | null {
  const base = d.env.XDG_CONFIG_HOME && d.env.XDG_CONFIG_HOME !== '' ? d.env.XDG_CONFIG_HOME : path.join(d.home, '.config')
  try {
    const parsed = JSON.parse(read(path.join(base, 'magpie', 'gateway.json'))) as { addr?: unknown }
    return typeof parsed.addr === 'string' ? parsed.addr : null
  } catch {
    return null
  }
}

export function shareWhere(d: DiscoveryEnv, interfaces: Record<string, readonly InterfaceAddress[] | undefined>, read?: (file: string) => string): ShareWhere {
  const addr = gatewayAddr(d, read)
  const port = Number(addr?.match(/:(\d+)$/)?.[1] ?? MAGPIE_PORT)
  return { onNetwork: gatewayOnNetwork(addr), urls: shareUrls(interfaces, port) }
}

/** The magpie CLI: on PATH, else where its installer links it, else inside the app. */
export function magpieBinary(d: DiscoveryEnv, exists: (file: string) => boolean = existsSync): string | null {
  for (const dir of (d.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '' && exists(path.join(dir, 'magpie'))) return path.join(dir, 'magpie')
  }
  const candidates = [path.join(d.home, '.local', 'bin', 'magpie'), '/Applications/magpie.app/Contents/MacOS/magpie']
  return candidates.find((file) => exists(file)) ?? null
}

export function magpieRunner(bin: string, timeoutMs = 20_000): MagpieRun {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    })
}
