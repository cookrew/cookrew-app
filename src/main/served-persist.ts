import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ServedTemplate } from './session-served'

/**
 * SERVING SURVIVES A RESTART.
 *
 * The registry of served templates was memory-only, and the failure it caused
 * was exactly the invisible kind: the owner saved a team as paid, was told it
 * is taking calls, restarted the app — and the address they handed out started
 * 404ing with no signal on either side. An owner stops serving by SAYING stop,
 * never by rebooting.
 *
 * File discipline: JSON under
 * ~/.cookrew, atomic tmp+rename writes. Sessions are deliberately NOT here — a
 * minted session's terminals die with the app, so on reboot a caller starts a
 * fresh session (and on a paid door is quoted again, for a session they will
 * actually get).
 */

export interface ServedPersistence {
  load(): readonly ServedTemplate[]
  save(list: readonly ServedTemplate[]): void
}

const isServeAccess = (v: unknown): v is ServedTemplate['access'] =>
  v === 'account' || v === 'paid'

/** A record is either the full shape we wrote, or it is dropped — a half-parsed
 *  serve entry would put a door on the network the owner never described. */
const isServedTemplate = (v: unknown): v is ServedTemplate => {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    typeof t.serviceId === 'string' &&
    typeof t.templateId === 'string' &&
    typeof t.slug === 'string' &&
    isServeAccess(t.access) &&
    (t.priceUsd === undefined || typeof t.priceUsd === 'string') &&
    (t.summary === undefined || typeof t.summary === 'string') &&
    (t.tags === undefined || (Array.isArray(t.tags) && t.tags.every((tag) => typeof tag === 'string')))
  )
}

export function servedTemplateFile(base: string): ServedPersistence {
  const file = path.join(base, 'served-templates.json')
  return {
    load(): readonly ServedTemplate[] {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        return Array.isArray(parsed) ? parsed.filter(isServedTemplate) : []
      } catch {
        // No file yet, or an unreadable one: boot with nothing served rather
        // than refusing to boot. serve() re-creates the file on first use.
        return []
      }
    },
    save(list: readonly ServedTemplate[]): void {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(list, null, 2))
      renameSync(tmp, file)
    }
  }
}
