import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * CANVAS TOKENS THIS MAC HAS ALREADY SPENT.
 *
 * A canvas token is good for ten minutes and says nothing about how many times
 * it may be used, so an admission captured off the wire — and the whole
 * ceremony travelled in the clear on the plaintext listener until this round —
 * could be replayed for the rest of that window and the Mac would open again,
 * happily, for whoever had the recording. Verifying a signature says the
 * registry wrote it; it cannot say it has not already been used.
 *
 * So a jti that admitted somebody is burned. This is the one piece of state a
 * stateless token cannot carry for itself, which is why it is also the one
 * thing worth persisting: a restart that forgot the list would reopen exactly
 * the window this closes, and desktops restart far more often than ten
 * minutes.
 *
 * BOUNDED, because it is written by anyone who can reach the port. A thousand
 * entries is more admissions than a Mac sees in a month, and each one falls
 * out on its own expiry anyway — the cap is the backstop, the expiry is the
 * mechanism.
 */

export const SPENT_MAX = 1000

export type SpentToken = {
  readonly jti: string
  /** The token's own expiry. Past it, the entry is dead weight. */
  readonly exp: number
}

export type SpentTokenStore = {
  /**
   * Burn a jti. TRUE means it was fresh and is now spent; FALSE means this
   * exact token has already admitted somebody.
   */
  readonly spend: (jti: string, exp: number) => boolean
  readonly spent: (jti: string) => boolean
  readonly list: () => readonly SpentToken[]
}

export const spentTokensFile = (base?: string): string =>
  path.join(base ?? path.join(homedir(), '.cookrew'), 'spent-tokens.json')

const looksLikeSpent = (value: unknown): value is SpentToken => {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.jti === 'string' && entry.jti.length > 0 && typeof entry.exp === 'number'
}

export const readSpentTokens = (base?: string): SpentToken[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(spentTokensFile(base), 'utf8'))
    const spent = (parsed as { spent?: unknown })?.spent
    return Array.isArray(spent) ? spent.filter(looksLikeSpent) : []
  } catch {
    return []
  }
}

const write = (spent: readonly SpentToken[], base?: string): void => {
  const file = spentTokensFile(base)
  const temp = `${file}.tmp`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(temp, `${JSON.stringify({ spent }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  chmodSync(file, 0o600)
}

export type SpentTokenStoreDeps = {
  readonly base?: string
  readonly now?: () => number
  readonly max?: number
}

export const createSpentTokenStore = (deps: SpentTokenStoreDeps = {}): SpentTokenStore => {
  const now = deps.now ?? Date.now
  const max = deps.max ?? SPENT_MAX

  /** Live entries only: an expired token is refused by its own `exp` anyway. */
  const live = (): SpentToken[] => readSpentTokens(deps.base).filter((entry) => entry.exp > now())

  return {
    spent: (jti) => live().some((entry) => entry.jti === jti),
    spend: (jti, exp) => {
      const existing = live()
      if (existing.some((entry) => entry.jti === jti)) return false
      // Oldest expiry first, so the cap drops what was closest to falling out
      // by itself rather than the entry that has the longest left to protect.
      const next = [...existing, { jti, exp }]
        .sort((a, b) => a.exp - b.exp)
        .slice(-max)
      try {
        write(next, deps.base)
      } catch (error) {
        // A jti that could not be written is a jti that is not burned, and
        // saying otherwise would let a replay through on the next attempt.
        console.error('Could not record a spent canvas token:', error)
        return false
      }
      return true
    },
    list: live
  }
}
