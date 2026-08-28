// The settings surface for recognised registry hosts.
//
// The ruling's second half: "configured, never inferred" must be REACHABLE.
// An environment variable is a configuration mechanism for whoever launches
// the process, which on a packaged app is nobody — so the only way an owner
// could ever recognise an install link was to not have a packaged app. That
// is why the out-of-box path was a dead end even though the empty default was
// correct.
//
// Deliberately its own file rather than a field on WorkspaceStore: a
// recognised host is not workspace state, it is a trust decision for the whole
// installation, and it must survive a workspace being deleted. It also keeps
// the blast radius of this lane off a store several other lanes are inside.
//
// ADDING A HOST IS THE TRUST DECISION. The file is the record of one, so it is
// written atomically and read strictly: an unparseable file recognises
// NOTHING rather than falling back to something, because a corrupted trust
// list must not degrade into a permissive one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function defaultRegistryHostsFile(): string {
  return path.join(homedir(), '.cookrew', 'registry-hosts.json')
}

export class RegistryHostSettings {
  constructor(private readonly file = defaultRegistryHostsFile()) {}

  /**
   * The configured hosts, or an EMPTY list when the file is missing or
   * unreadable.
   *
   * Empty is the fail-closed direction and the honest one: a trust list we
   * cannot read is not a trust list. The refusal path then tells the owner
   * exactly what to do, which is strictly better than silently recognising a
   * host from a half-parsed file.
   */
  list(): string[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((host): host is string => typeof host === 'string' && host.length > 0)
    } catch (error) {
      console.error('Registry host settings unreadable — recognising no hosts:', error)
      return []
    }
  }

  /** Record a host as recognised. Idempotent; order is insertion order. */
  add(host: string): string[] {
    const normalized = host.trim().toLowerCase()
    if (normalized.length === 0) throw new Error('A registry host must not be empty')
    const next = [...new Set([...this.list(), normalized])]
    this.save(next)
    return next
  }

  /** Stop recognising a host. Idempotent. */
  remove(host: string): string[] {
    const normalized = host.trim().toLowerCase()
    const next = this.list().filter((entry) => entry !== normalized)
    this.save(next)
    return next
  }

  /**
   * Write via a sibling and rename: a crash mid-write must leave the previous
   * trust list intact rather than a truncated one, which `list()` would then
   * read as "recognise nothing" and lock the owner out of their own registry.
   */
  private save(hosts: readonly string[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const pending = `${this.file}.pending`
    writeFileSync(pending, JSON.stringify(hosts, null, 2), 'utf8')
    renameSync(pending, this.file)
  }
}
