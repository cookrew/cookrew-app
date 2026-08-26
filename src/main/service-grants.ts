import path from 'node:path'
import { homedir } from 'node:os'
import { grantable } from './session-env'
import { confine } from './session-sandbox'

/**
 * THE LEND — a deliberate, per-service credential grant (R30 G2).
 *
 * A minted crew starts with nothing. `sessionEnv` is an allowlist and HOME is
 * the sandbox, so an agent booted for a stranger finds no API key, no
 * `~/.claude`, no provider registry — and exits. That is the correct DEFAULT
 * and it is also why serving a real crew does not work until somebody lends it
 * something. This module is the lending.
 *
 * IT IS NOT A COPY OF THE OWNER'S CREDENTIALS, and that distinction is the
 * whole ruling. Blanket-copying `~/.claude/.credentials.json` into every
 * sandbox would make every served crew work in one line and hand every caller's
 * agent the owner's refresh token — an account, not a key, with no bound and no
 * per-service revocation. What an owner grants here they grant on purpose, to
 * ONE service, with a number attached.
 *
 * THE NUMBER IS REQUIRED, and a grant without one is refused rather than read
 * as "unlimited". A lend whose size nobody wrote down is the shape this
 * program keeps having to apologise for; the fail-closed direction costs an
 * owner one field and costs a caller nothing they were promised.
 *
 * WHAT IT DOES NOT BOUND, stated rather than discovered. The budget counts
 * SESSIONS, because sessions are the unit this app actually mints and can
 * therefore actually count. It is not a dollar ceiling: nothing in this tree
 * measures token spend, and a `maxUsd` field would be a number that looked like
 * a limit and enforced nothing. A session count is a real bound on a real
 * quantity — see `service-grants-store.ts` for where it is spent.
 *
 * THREE WAYS TO LEND, because harnesses take their credentials differently:
 *
 *   env      names in the OWNER'S OWN environment, forwarded by name. The
 *            classic `ANTHROPIC_API_KEY` case, and the only one that stores
 *            nothing new anywhere.
 *   envFile  a `KEY=value` file the owner already keeps (0600, outside any
 *            repo). Every key in it is lent. This exists because the real
 *            credentials on a developer's machine are in files, not exported —
 *            an env-name-only grant reads as supported and lends nothing.
 *   files    an explicit copy into the sandbox's HOME, for a harness
 *            configured by file rather than environment (`pi` finds its
 *            providers at `$HOME/.pi/agent/models.json` and nowhere else).
 */

/** One file the owner lends, copied into the session's sandbox HOME. */
export interface GrantedFile {
  /** Absolute path on the owner's disk. */
  readonly from: string
  /** Relative path under the sandbox HOME — `.pi/agent/models.json`. */
  readonly to: string
}

/** What one service was lent. Absent (null) is the default and means nothing. */
export interface ServiceGrant {
  /** Names forwarded from the owner's own environment. */
  readonly env: readonly string[]
  /** A `KEY=value` file whose every entry is lent, or null. */
  readonly envFile: string | null
  readonly files: readonly GrantedFile[]
  /** How many sessions this grant may ever mint. Required, and > 0. */
  readonly maxSessions: number
}

/**
 * A grant, plus everything wrong with the way it was written.
 *
 * Problems are returned rather than thrown because a malformed grant must not
 * stop the app booting, and are never silently dropped because a lend that
 * quietly did not happen presents as "the agent is broken" — the most expensive
 * possible way to learn about a typo. `grant: null` with problems is a REFUSAL;
 * `grant` with problems is a partial lend whose gaps have been named.
 */
export interface GrantReading {
  readonly grant: ServiceGrant | null
  readonly problems: readonly string[]
}

const NO_GRANT: GrantReading = { grant: null, problems: [] }

/** `~` at the start means the owner's home. Nothing else is expanded. */
export function expandHome(value: string, home: string = homedir()): string {
  if (value === '~') return home
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : value
}

/**
 * Read ONE service's grant out of the parsed config.
 *
 * Pure, and total: every shape a hand-written JSON file can take resolves to a
 * reading, so the caller has no branch that can throw. An unlisted service is
 * `NO_GRANT` — not an error, just a crew that was lent nothing.
 */
export function readGrant(
  raw: unknown,
  serviceId: string,
  home: string = homedir()
): GrantReading {
  if (typeof raw !== 'object' || raw === null) return NO_GRANT
  const entry = (raw as Record<string, unknown>)[serviceId]
  if (entry === undefined) return NO_GRANT
  if (typeof entry !== 'object' || entry === null) {
    return { grant: null, problems: [`${serviceId}: the grant is not an object`] }
  }

  const e = entry as Record<string, unknown>
  const problems: string[] = []

  // THE BUDGET FIRST, and it refuses the whole grant. A lend with no number is
  // the one misconfiguration that must not degrade into a working system.
  const max = e.maxSessions
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
    return {
      grant: null,
      problems: [
        `${serviceId}: lent nothing — a grant needs "maxSessions", a whole number above zero`
      ]
    }
  }

  const env: string[] = []
  for (const name of stringList(e.env, `${serviceId}: "env"`, problems)) {
    // `grantable` refuses HOME/PATH and friends: a granted HOME would overwrite
    // the sandbox scrub itself. Named here as well as at the spawn because this
    // is where an owner can be TOLD, and the spawn can only be silent.
    if (grantable(name)) env.push(name)
    else problems.push(`${serviceId}: "${name}" cannot be lent — it defines the sandbox`)
  }

  let envFile: string | null = null
  if (e.envFile !== undefined) {
    if (typeof e.envFile !== 'string' || e.envFile.trim().length === 0) {
      problems.push(`${serviceId}: "envFile" must be a path`)
    } else {
      const resolved = expandHome(e.envFile.trim(), home)
      if (!path.isAbsolute(resolved)) {
        problems.push(`${serviceId}: "envFile" must be an absolute path — got '${e.envFile}'`)
      } else {
        envFile = resolved
      }
    }
  }

  const files: GrantedFile[] = []
  for (const item of arrayOf(e.files, `${serviceId}: "files"`, problems)) {
    const file = readGrantedFile(item, serviceId, home, problems)
    if (file) files.push(file)
  }

  return { grant: { env, envFile, files, maxSessions: max }, problems }
}

/**
 * One `{ from, to }` pair, or null with the reason recorded.
 *
 * `to` is confined against a nominal root: a destination that climbs out of the
 * sandbox would write a granted file into the owner's own tree, turning a lend
 * into an overwrite. It is checked here rather than at the copy because this is
 * the layer that can name the offending line.
 */
function readGrantedFile(
  item: unknown,
  serviceId: string,
  home: string,
  problems: string[]
): GrantedFile | null {
  if (typeof item !== 'object' || item === null) {
    problems.push(`${serviceId}: a "files" entry must be { from, to }`)
    return null
  }
  const f = item as Record<string, unknown>
  if (typeof f.from !== 'string' || typeof f.to !== 'string') {
    problems.push(`${serviceId}: a "files" entry needs a string "from" and "to"`)
    return null
  }
  const from = expandHome(f.from.trim(), home)
  if (!path.isAbsolute(from)) {
    problems.push(`${serviceId}: "${f.from}" must be an absolute path`)
    return null
  }
  const to = f.to.trim().replace(/^\/+/, '')
  if (to.length === 0 || confine('/sandbox', path.join('/sandbox', to)) === null) {
    problems.push(`${serviceId}: "${f.to}" must stay inside the session's own folder`)
    return null
  }
  return { from, to }
}

/**
 * Parse a `KEY=value` env file.
 *
 * Deliberately small: comments, blank lines, a leading `export`, and quotes
 * around the value. Not a shell — a file that needs `$(…)` to be evaluated is a
 * file this must refuse to guess at, and the entries it cannot read are simply
 * absent, which fails the visible way.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const name = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    let value = body.slice(eq + 1).trim()
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1)
    out[name] = value
  }
  return out
}

function stringList(value: unknown, label: string, problems: string[]): string[] {
  return arrayOf(value, label, problems).filter((v): v is string => {
    if (typeof v === 'string') return true
    problems.push(`${label} holds something that is not a name`)
    return false
  })
}

function arrayOf(value: unknown, label: string, problems: string[]): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push(`${label} must be a list`)
    return []
  }
  return value
}
