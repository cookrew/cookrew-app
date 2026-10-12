/**
 * THE SCRUB — every string that leaves main for a pane, a phone, a wall or
 * a ledger passes through here (HP contract, docs/route-program/LEDGER.md).
 *
 * It replaces VALUES, never words: the sealed secrets this Mac holds
 * (secrets-store.ts), the pairing token, the gateway key, the values of env
 * vars whose NAMES say KEY / TOKEN / SECRET / PASSWORD, and anything that
 * looks like a credential on its own — a known prefix (`sk-`, `ghp_`,
 * `xox…-`, `apikey_`) or a high-entropy run (32+ of base64, 32+ of hex,
 * 40+ of URL-safe base64). "pairing token" and "API key" as words survive,
 * a sentence of Chinese survives, and scrubbing twice is scrubbing once.
 *
 * Exact values are matched by content, so a secret that is also a common
 * word would be replaced wherever it appears; values under 8 characters are
 * therefore never matched by content — nothing that short is a secret worth
 * mangling prose for.
 */

export const REDACTED = '[redacted]'

export interface ScrubDeps {
  /** The sealed values, read when a scrub runs (never cached across calls). */
  readonly secrets?: () => readonly string[]
  /** Tokens this Mac holds: the pairing token, the gateway key. */
  readonly tokens?: () => readonly (string | null | undefined)[]
  readonly env?: NodeJS.ProcessEnv
}

export type Scrub = (text: string) => string

/** The shortest value matched by content. */
export const MIN_VALUE_LENGTH = 8

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i

/** A credential by its shape, with no knowledge of this Mac. */
const SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{8,}/g,
  /\bgh[opsur]_[A-Za-z0-9]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bapikey_[A-Za-z0-9]{8,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
  /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g
]

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const secretEnvValues = (env: NodeJS.ProcessEnv): string[] =>
  Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string')
    .map(([, value]) => value as string)

/** Replace every exact value, longest first so a value inside another is not left as a stub. */
const replaceValues = (text: string, values: readonly string[]): string => {
  const distinct = [...new Set(values.filter((value) => value.length >= MIN_VALUE_LENGTH))].sort(
    (a, b) => b.length - a.length
  )
  let out = text
  for (const value of distinct) out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED)
  return out
}

export const createScrubber = (deps: ScrubDeps = {}): Scrub => {
  const env = deps.env ?? process.env
  return (text: string): string => {
    if (typeof text !== 'string' || text.length === 0) return text
    const values = [
      ...(deps.secrets?.() ?? []),
      ...(deps.tokens?.() ?? []).filter((token): token is string => typeof token === 'string'),
      ...secretEnvValues(env)
    ]
    let out = replaceValues(text, values)
    for (const shape of SHAPES) out = out.replace(shape, REDACTED)
    return out
  }
}

/** The scrub with nothing of this Mac's: shapes only. For tests and pure callers. */
export const scrubShapes: Scrub = createScrubber({ env: {} })
