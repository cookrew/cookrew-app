/**
 * THE SCRUB — every string that leaves main for a pane, a phone, a wall or
 * a ledger passes through here (HP contract, docs/route-program/LEDGER.md).
 *
 * It replaces VALUES, never words: the sealed secrets this Mac holds
 * (secrets-store.ts), the pairing token, the gateway keys, the values of env
 * vars whose NAMES say KEY / TOKEN / SECRET / PASSWORD, and a credential by
 * its own shape — a known prefix (`sk-`, `ghp_`, `xox…-`, `apikey_`,
 * `AKIA`), a padded base64 run of 32+, or a 32+ run right after a bearer /
 * token= / key= introducer. Bare hex and bare URL-safe runs are NOT shapes:
 * a git SHA, a long path segment and a kebab branch name are prose here
 * (round 2). "pairing token" and "API key" as words survive, a sentence of
 * Chinese survives, and scrubbing twice is scrubbing once.
 *
 * THE VALUE TABLE IS A SNAPSHOT. Reading every sealed value on every string
 * put a file read per secret under each inbox rebuild (rows × reasons, on
 * the main thread). The table is built once and kept for SNAPSHOT_TTL_MS,
 * and dropped at once when the store changes (SecretsStore.onChange) — so a
 * value sealed a moment ago is scrubbed on the next string, and a thousand
 * strings in a burst cost one table.
 *
 * Exact values are matched by content, so values under 8 characters are
 * never matched, and the literal defaults (`magpie-cookrew`, `magpie-sous`)
 * are never in the table: a default is not a secret, and redacting it would
 * blank the Routing panel's own sentence.
 */

export const REDACTED = '[redacted]'

export interface ScrubDeps {
  /** The sealed values, read when the table is (re)built. */
  readonly secrets?: () => readonly string[]
  /** Tokens this Mac holds: the pairing token, the gateway keys. */
  readonly tokens?: () => readonly (string | null | undefined)[]
  readonly env?: NodeJS.ProcessEnv
  /** The store's change signal: the table is dropped on it. */
  readonly onChange?: (listener: () => void) => void
  readonly ttlMs?: number
  readonly now?: () => number
}

export interface Scrub {
  (text: string): string
  /** Drop the value table; the next string rebuilds it. */
  invalidate(): void
}

/** The shortest value matched by content. */
export const MIN_VALUE_LENGTH = 8

/** How long a value table serves before it is rebuilt, absent a change signal. */
export const SNAPSHOT_TTL_MS = 2_000

/** Local tokens that are not secrets: never redacted by value. */
export const DEFAULT_VALUES: ReadonlySet<string> = new Set(['magpie-cookrew', 'magpie-sous'])

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i

/** A credential by its shape, with no knowledge of this Mac. */
const SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{8,}/g,
  /\bgh[opsur]_[A-Za-z0-9]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bapikey_[A-Za-z0-9]{8,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  // 32+ of base64 WITH its '=' padding: a shape no SHA or path has.
  /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={1,2}(?![A-Za-z0-9+/=])/g
]

/** A 32+ run that an introducer names as a credential: the run goes, the introducer stays. */
const INTRODUCED = /\b(bearer\s+|token=|key=|apikey=|secret=|password=)([A-Za-z0-9+/_.-]{32,})/gi

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const secretEnvValues = (env: NodeJS.ProcessEnv): string[] =>
  Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string')
    .map(([, value]) => value as string)

/** The table: one regex over every value, longest first so a value inside another is not left as a stub. */
const compile = (values: readonly string[]): RegExp | null => {
  const distinct = [...new Set(values.filter((value) => value.length >= MIN_VALUE_LENGTH && !DEFAULT_VALUES.has(value)))].sort(
    (a, b) => b.length - a.length
  )
  return distinct.length === 0 ? null : new RegExp(distinct.map(escapeRegExp).join('|'), 'g')
}

export const createScrubber = (deps: ScrubDeps = {}): Scrub => {
  const env = deps.env ?? process.env
  const now = deps.now ?? ((): number => Date.now())
  const ttl = deps.ttlMs ?? SNAPSHOT_TTL_MS
  let table: { values: RegExp | null; at: number } | null = null

  const build = (): RegExp | null =>
    compile([
      ...(deps.secrets?.() ?? []),
      ...(deps.tokens?.() ?? []).filter((token): token is string => typeof token === 'string'),
      ...secretEnvValues(env)
    ])
  const current = (): RegExp | null => {
    const at = now()
    if (table === null || at - table.at > ttl) table = { values: build(), at }
    return table.values
  }
  const invalidate = (): void => {
    table = null
  }
  deps.onChange?.(invalidate)

  const scrub = ((text: string): string => {
    if (typeof text !== 'string' || text.length === 0) return text
    const values = current()
    let out = values === null ? text : text.replace(values, REDACTED)
    for (const shape of SHAPES) out = out.replace(shape, REDACTED)
    out = out.replace(INTRODUCED, (_match, introducer: string) => `${introducer}${REDACTED}`)
    return out
  }) as Scrub
  scrub.invalidate = invalidate
  return scrub
}

/** The scrub with nothing of this Mac's: shapes only. For tests and pure callers. */
export const scrubShapes: Scrub = createScrubber({ env: {} })
