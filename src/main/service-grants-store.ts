import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { confine } from './session-sandbox'
import { parseEnvFile, readGrant, type ServiceGrant } from './service-grants'

/**
 * THE LEND, ON DISK — the owner's grant file, the budget ledger, and the one
 * copy that puts a granted file inside a sandbox.
 *
 * Split from `service-grants.ts` so the shape rules stay pure and testable
 * without a filesystem; everything here touches disk and nothing here decides
 * policy.
 *
 * READ PER CALL, NEVER CACHED. An owner who revokes a grant, or spends its last
 * session, must not have to restart the app for it to mean anything — the same
 * lesson the hosted-Sous config learned. The file is small and a mint is
 * already the most expensive thing in the program.
 *
 * THE LEDGER IS SEPARATE FROM THE GRANT, because they are written by different
 * hands: the grant is the owner's, hand-edited, and must never be rewritten by
 * us (a program that reformats a human's config eventually loses a comment or a
 * key). The ledger is ours.
 *
 * SPENT IS SPENT. Ending a session does not refund it. The budget bounds how
 * much of the owner's credential a service may ever have been handed, not how
 * many sessions are open at once — a caller who could END and re-mint in a loop
 * would otherwise have no bound at all.
 */

/** `~/.cookrew/service-grants.json` — the owner's file, hand-written, 0600. */
export function grantConfigPath(base: string): string {
  return process.env.COOKREW_SERVICE_GRANTS ?? path.join(base, 'service-grants.json')
}

/** `~/.cookrew/service-grants-spent.json` — ours, never the owner's. */
export function grantLedgerPath(base: string): string {
  return path.join(base, 'service-grants-spent.json')
}

/** What the spawn and the mint ask about a service. */
export interface ServiceGrants {
  /** The grant, or null when this service was lent nothing. */
  grantFor(serviceId: string): ServiceGrant | null
  /**
   * The env a served terminal spawns with: the owner's own, plus the values
   * this service was deliberately lent. `sessionEnv` still allowlists by NAME
   * on top of this, so widening it here lends nothing on its own.
   */
  ownerEnvFor(serviceId: string): Record<string, string | undefined>
  /** The names to forward — the grant's own, plus every key of its envFile. */
  envKeysFor(serviceId: string): readonly string[]
  /**
   * May this service mint ANOTHER session? True when it was lent nothing (there
   * is no budget to exceed) and while a grant has budget left.
   */
  allowsNewSession(serviceId: string): boolean
  /** Copy the granted files in and spend one session. Throws if it cannot. */
  provision(serviceId: string, sandbox: string): void
}

/**
 * Read a grant file, resolve one service, and answer the four questions the
 * spawn and the mint ask. Every read hits disk; see the header.
 */
export function serviceGrants(base: string, log = console.error): ServiceGrants {
  const readConfig = (): unknown => {
    const file = grantConfigPath(base)
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      // No file is the ordinary case — most owners lend nothing. A file that
      // exists and cannot be read is NOT ordinary and gets a line, because the
      // symptom otherwise is a crew that mysteriously has no credentials.
      if (existsSync(file)) {
        log(`service grants: ignoring ${file} — ${(error as Error).message}`)
      }
      return null
    }
  }

  const resolve = (serviceId: string): ServiceGrant | null => {
    const { grant, problems } = readGrant(readConfig(), serviceId)
    for (const problem of problems) log(`service grants: ${problem}`)
    return grant
  }

  /** The envFile's entries, or {} — an unreadable file is named, not guessed. */
  const envFileValues = (grant: ServiceGrant | null): Record<string, string> => {
    if (!grant?.envFile) return {}
    try {
      warnIfWorldReadable(grant.envFile, log)
      return parseEnvFile(readFileSync(grant.envFile, 'utf8'))
    } catch (error) {
      log(`service grants: cannot read envFile ${grant.envFile} — ${(error as Error).message}`)
      return {}
    }
  }

  const spentFor = (serviceId: string): number => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(grantLedgerPath(base), 'utf8'))
      const value = (parsed as Record<string, unknown>)?.[serviceId]
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }

  const spendOne = (serviceId: string): void => {
    const file = grantLedgerPath(base)
    let ledger: Record<string, number> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) ledger = parsed as Record<string, number>
    } catch {
      // A missing or corrupt ledger starts over at zero rather than blocking a
      // mint. It is a spend counter, not an authorisation record — the grant
      // file is the authorisation, and it is never written by us.
    }
    const next = { ...ledger, [serviceId]: (Number(ledger[serviceId]) || 0) + 1 }
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    grantFor: resolve,

    ownerEnvFor(serviceId) {
      const grant = resolve(serviceId)
      // The owner's own environment FIRST, the lent values over it: a value the
      // owner wrote into a grant file for this service is the more specific
      // answer, and it is the only way an envFile can override an ambient
      // ANTHROPIC_BASE_URL that happens to be exported.
      return { ...process.env, ...envFileValues(grant) }
    },

    envKeysFor(serviceId) {
      const grant = resolve(serviceId)
      if (!grant) return []
      return [...new Set([...grant.env, ...Object.keys(envFileValues(grant))])]
    },

    allowsNewSession(serviceId) {
      const grant = resolve(serviceId)
      // Nothing lent, nothing to bound. A crew that needs no credential — a
      // local model, a shell — serves exactly as it did before this existed.
      if (!grant) return true
      return spentFor(serviceId) < grant.maxSessions
    },

    provision(serviceId, sandbox) {
      const grant = resolve(serviceId)
      if (!grant) return
      if (spentFor(serviceId) >= grant.maxSessions) {
        throw new Error(
          `'${serviceId}' has spent its grant — ${grant.maxSessions} session(s). ` +
            `Raise maxSessions in ${grantConfigPath(base)} to lend more.`
        )
      }
      for (const file of grant.files) copyGranted(file.from, sandbox, file.to)
      // Spent AFTER the copies, so a grant whose files are missing does not
      // silently burn a session the caller never got.
      spendOne(serviceId)
    }
  }
}

/**
 * Copy one lent file into the sandbox, 0600.
 *
 * Confined again here even though `readGrant` already checked the destination:
 * this is the call that writes, and a write that trusts an upstream check is
 * the one that turns a config typo into a file in the owner's home. Modes are
 * forced rather than preserved — the copy is a credential by assumption.
 */
function copyGranted(from: string, sandbox: string, to: string): void {
  const target = confine(sandbox, to)
  if (target === null) {
    throw new Error(`granted file '${to}' would land outside the session's folder`)
  }
  if (!existsSync(from)) {
    throw new Error(`granted file '${from}' is not on this machine`)
  }
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(from, target)
  chmodSync(target, 0o600)
}

/**
 * A lent credential file that anyone on the machine can read is worth saying
 * out loud once. Not refused: it is the owner's file and their call, and a
 * boot-time refusal over a permission bit would be this program deciding
 * something it was not asked to decide.
 */
function warnIfWorldReadable(file: string, log: (message: string) => void): void {
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      log(`service grants: ${file} is readable by other users — chmod 600 it`)
    }
  } catch {
    // Unreadable stat is reported by the read that follows.
  }
}
