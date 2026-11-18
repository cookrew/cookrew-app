import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MAGPIE_PORT, privateHost, tailnetHost } from '../../shared/remote-magpie'
import type { PendingKey, ShareHandover, ShareIssueAnswer, SharedKey, ShareWhere } from '../../shared/share-devices'
import type { DiscoveryEnv } from './discovery'
import { INTENT_NAME_RE, type IntentStore, type ShareIntent } from './share-intents'

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
 * Only keys this module made are listed or revoked: `device-<slug>--<32 hex>`
 * (and `device-<slug>` from before recovery v1). Keys the owner made by hand in
 * Magpie (`solis-compare`) are theirs.
 *
 * A key being made is written down first (share-intents.ts): if anything goes
 * wrong between the add and the hand-over, every key of that random name is
 * revoked by id and a warning stays until the owner clears it by hand.
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
/** Before recovery v1 a device key was named `device-<slug>`: still listed and revocable. */
const LEGACY_NAME_RE = /^device-[a-z0-9][a-z0-9-]{0,31}$/
/** Magpie's masked key column (0.1.3935): `sk-magpie-key-…5102ac`, the last characters of the key. */
const MASK_TAIL_RE = /…([A-Za-z0-9_-]{4,})$/

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
  /** The key's last characters as Magpie shows them, or null when it shows none. */
  tail: string | null
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
    const [id, name, , masked, limit] = cells
    if (!ID_RE.test(id)) throw new Error('Magpie returned an invalid gateway key ID.')
    return { id, name, limit: limit && limit !== '-' ? limit : null, tail: masked.match(MASK_TAIL_RE)?.[1] ?? null }
  })
}

/** The device a key was made for, from its name; null for a key this module did not make. */
export function deviceOfName(name: string): string | null {
  if (INTENT_NAME_RE.test(name)) return name.slice(DEVICE_PREFIX.length, name.lastIndexOf('--'))
  return LEGACY_NAME_RE.test(name) ? name.slice(DEVICE_PREFIX.length) : null
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

export interface ShareKeysDeps {
  run: MagpieRun
  /** Where keys being made are written down first (share-intents.ts). */
  intents: IntentStore
  /** 128 random bits as 32 hex characters; injected for tests. */
  nonce?: () => string
  /** Every running process's command line, for the process check; injected for tests. */
  processes?: () => Promise<string[]>
  now?: () => Date
}

export class ShareKeys {
  /** The key last handed over, kept in memory only until the owner says Done, so a reloaded window still finds it. */
  private handed: ShareHandover | null = null
  private busy = 0

  constructor(private readonly deps: ShareKeysDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString()
  }

  private async rows(): Promise<KeyRow[]> {
    const answer = await this.deps.run(['gateway-key', 'list'])
    if (answer.code !== 0) throw new Error(firstLine(answer.stderr) ?? 'Magpie did not list its keys.')
    return parseKeyTable(answer.stdout)
  }

  /** Magpie's whole key list, read now (magpie-remote/serve.ts checks a bound key against it). */
  listed(): Promise<KeyRow[]> {
    return this.rows()
  }

  private async keys(): Promise<SharedKey[]> {
    return (await this.rows()).flatMap((row) => {
      const device = deviceOfName(row.name)
      return device === null ? [] : [{ id: row.id, name: row.name, device, limit: row.limit }]
    })
  }

  private readIntents(): readonly ShareIntent[] {
    try {
      return this.deps.intents.read()
    } catch {
      throw new Error(INTENTS_UNREADABLE)
    }
  }

  /** The device keys, every open intent with whether it may be cleared yet, and what is in flight. */
  async list(): Promise<{ keys: SharedKey[]; pending: PendingKey[]; issuing: boolean; handover: ShareHandover | null }> {
    const pending = this.readIntents().map((i) => ({ name: i.name, device: i.device, at: i.at, revoked: i.revoked ?? null, checked: i.checked ?? null, clearable: clearable(i) }))
    return { keys: await this.keys(), pending, issuing: this.busy > 0, handover: this.handed }
  }

  /** One issue at a time: two adds racing could hand out a key nobody capped. */
  private queue: Promise<unknown> = Promise.resolve()

  issue(input: { device: unknown; dailyUsd: unknown }, permitted: () => boolean = () => true): Promise<ShareIssueAnswer> {
    this.busy += 1
    const next = this.queue.then(() => this.issueNow(input, permitted)).finally(() => {
      this.busy -= 1
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private async issueNow(input: { device: unknown; dailyUsd: unknown }, permitted: () => boolean): Promise<ShareIssueAnswer> {
    const device = deviceSlug(typeof input.device === 'string' ? input.device : '')
    if (!DEVICE_RE.test(device)) return refusal('Name the device, such as “laptop”.')
    const daily = typeof input.dailyUsd === 'number' && Number.isFinite(input.dailyUsd) ? Math.round(input.dailyUsd * 100) / 100 : NaN
    if (!(daily >= DAILY_USD_MIN && daily <= DAILY_USD_MAX)) return refusal(`Set a daily cap between $${DAILY_USD_MIN} and $${DAILY_USD_MAX}.`)
    let intents: readonly ShareIntent[]
    try {
      intents = this.readIntents()
    } catch (error) {
      return refusal(errorText(error))
    }
    if (intents.some((i) => i.device === device)) return refusal(`A key for “${device}” may have been left behind. Resolve the warning first.`)
    const before = await this.keys()
    if (before.some((row) => row.device === device)) return refusal(`“${device}” already has a key. Revoke it first to make a new one.`)
    if (!permitted()) return refusal('Magpie sharing was switched off.')
    const name = `${DEVICE_PREFIX}${device}--${(this.deps.nonce ?? (() => randomBytes(16).toString('hex')))()}`
    try {
      // Written and synced before Magpie hears the name: from here on, a crash leaves a warning, never a lost key.
      this.deps.intents.write([...intents, { name, device, at: this.now() }])
    } catch {
      return refusal('Cookrew could not write down the key it was about to make, so it made none.')
    }
    try {
      const added = await this.deps.run(['gateway-key', 'add', name])
      const key = added.stdout.trim()
      const ours = (await this.rows()).filter((row) => row.name === name)
      if (added.code !== 0 || !KEY_RE.test(key)) return await this.revokeAll(name, firstLine(added.stderr) ?? 'Magpie did not return a usable key.')
      if (ours.length !== 1) return await this.revokeAll(name, `Magpie lists ${ours.length} keys named “${name}”.`)
      const [row] = ours
      // The key we hold must be the row we cap: Magpie shows its last characters.
      if (row.tail === null || !key.endsWith(row.tail)) return await this.revokeAll(name, 'The key Magpie returned is not the one it lists.')
      const capped = await this.capped(row.id, daily)
      if (capped !== null) return await this.revokeAll(name, capped)
      if (!permitted()) return await this.revokeAll(name, 'Magpie sharing was switched off.')
      const shared: SharedKey = { id: row.id, name, device, limit: `$${daily} per day` }
      this.settle(name)
      this.handed = { id: row.id, device, key }
      return { ok: true, key, shared }
    } catch (error) {
      return await this.revokeAll(name, errorText(error))
    }
  }

  /** The key is capped and handed over: it is an ordinary device key now, listed under its own name. */
  private settle(name: string): void {
    try {
      this.deps.intents.write(this.readIntents().filter((i) => i.name !== name))
    } catch {
      // The intent stays and warns: resolving it would revoke this key, which is the safe side.
    }
  }

  /** Revoke every key Magpie lists under an intent's name, by id; the intent stays and records the pass. */
  private async revokeAll(name: string, why: string): Promise<ShareIssueAnswer> {
    const pass = await this.revokePass(name).catch(() => null)
    const tail = pass === null ? ' Magpie could not be asked which keys carry its name; a warning stays until you check.' : pass.left > 0 ? ` ${pass.left} key(s) named “${name}” could not be revoked; a warning stays until you check.` : ' Every key it may have made was revoked; a warning stays until you check.'
    return refusal(`${why}${tail}`)
  }

  private async revokePass(name: string): Promise<{ left: number }> {
    for (const row of (await this.rows()).filter((r) => r.name === name)) {
      await this.deps.run(['gateway-key', 'remove', row.id]).catch(() => null)
    }
    const left = (await this.rows()).filter((r) => r.name === name).length
    this.record(name, { revoked: { at: this.now(), left } })
    return { left }
  }

  private record(name: string, patch: Pick<ShareIntent, 'revoked'> | Pick<ShareIntent, 'checked'>): void {
    this.deps.intents.write(this.readIntents().map((i) => (i.name === name ? { ...i, ...patch } : i)))
  }

  /** The owner's "Revoke and check": one revoke pass, then one process check, both recorded on the intent. */
  async resolve(name: unknown): Promise<{ ok: true; left: number; live: number } | { ok: false; why: string }> {
    if (typeof name !== 'string' || !this.readIntents().some((i) => i.name === name)) return { ok: false, why: 'No such key being made.' }
    try {
      const { left } = await this.revokePass(name)
      const live = (await (this.deps.processes ?? runningCommands)()).filter((line) => addsName(line, name)).length
      this.record(name, { checked: { at: this.now(), live } })
      return { ok: true, left, live }
    } catch (error) {
      return { ok: false, why: errorText(error) }
    }
  }

  /** Clear an intent by hand: only once a revoke pass left none of its keys and a process check found no add running. */
  async clear(name: unknown): Promise<{ ok: true } | { ok: false; why: string }> {
    let intents: readonly ShareIntent[]
    try {
      intents = this.readIntents()
    } catch (error) {
      return { ok: false, why: errorText(error) }
    }
    const intent = intents.find((i) => i.name === name)
    if (!intent) return { ok: false, why: 'No such key being made.' }
    if (!clearable(intent)) return { ok: false, why: 'Revoke and check first: a key of this name may still exist or still be in the making.' }
    try {
      this.deps.intents.write(intents.filter((i) => i.name !== name))
      return { ok: true }
    } catch (error) {
      return { ok: false, why: errorText(error) }
    }
  }

  /** The owner copied the key: main forgets it. */
  done(id: unknown): void {
    if (this.handed?.id === id) this.handed = null
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
    const mine = (await this.keys()).some((row) => row.id === id)
    if (!mine) return { ok: false, why: 'Only a key made here for a device can be revoked here.' }
    const removed = await this.deps.run(['gateway-key', 'remove', id])
    if (removed.code !== 0) return { ok: false, why: firstLine(removed.stderr) ?? 'Magpie did not remove the key.' }
    if (this.handed?.id === id) this.handed = null
    return { ok: true }
  }
}

export const INTENTS_UNREADABLE = 'Cookrew cannot read its record of keys being made (~/.cookrew/share-intents.json). No key is made until it can.'

/** A revoke pass left no key of the name, and a process check after it found no add of the name running. */
function clearable(i: ShareIntent): boolean {
  return i.revoked !== undefined && i.revoked.left === 0 && i.checked !== undefined && i.checked.live === 0 && i.checked.at >= i.revoked.at
}

/** A `magpie gateway-key add <name>` command line: the name as its own word right after `add`. */
function addsName(line: string, name: string): boolean {
  const words = line.trim().split(/\s+/)
  return words.some((word, at) => word === 'gateway-key' && words[at + 1] === 'add' && words[at + 2] === name)
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Magpie did not answer.')

/** Every process's command line (the process check). Throws when the list cannot be had: no list is no check. */
export function runningCommands(): Promise<string[]> {
  const [bin, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }']]
      : ['ps', ['-axww', '-o', 'command=']]
  return new Promise((resolve, reject) => {
    execFile(bin, args as string[], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('The process check could not list running programs.'))
      resolve(String(stdout).split(/\r?\n/).filter((line) => line.trim() !== ''))
    })
  })
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
