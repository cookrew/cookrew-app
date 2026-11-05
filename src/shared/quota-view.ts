import type { RouteQuota, RouteQuotaWindow } from './route'

/**
 * EACH ACCOUNT, AS THE PANEL SAYS IT (route program, Magpie settings).
 *
 * Pure. Per window: what is left, when it comes back, and roughly how many
 * tokens that is. The token figure is derived, never asked for: the gateway
 * says what the window already spent (`tokensUsed`) and what percent that
 * was, so the whole is tokens ÷ percent and what is left is the whole ×
 * the percent left. Only when the gateway gave the spend; a window magpie
 * will not estimate itself (`estimateWhy`) says why instead of a number.
 */

export interface WindowView {
  name: string
  /** 0..1 LEFT (a battery: full when nothing is used), or null for a counter with nothing to divide by. */
  leftFill: number | null
  /** "70% left", "80 credits left", or the counter as it is. */
  left: string
  /** "resets in 5d 3h", "resetting", or null when the gateway gave no time. */
  resets: string | null
  /** "≈56M tokens left · 24M used", or null. */
  tokens: string | null
  /** "$2,608 at API prices", or null when unpriced. */
  value: string | null
  /** Why there is no token figure, when the gateway said. */
  note: string | null
  hot: boolean
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 24_147_633 → "24M", 5_630_000 → "5.6M": one decimal under ten, none above. */
export function compactCount(n: number): string {
  const steps: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]
  for (const [size, suffix] of steps) {
    if (Math.abs(n) >= size) {
      const v = n / size
      return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${suffix}`
    }
  }
  return String(Math.round(n))
}

/** A span in its two largest parts: "5d 3h", "4h 12m", "12m", "<1m". */
export function inDuration(ms: number): string {
  if (ms < MIN) return '<1m'
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MIN)
  const parts: [number, string][] = d > 0 ? [[d, 'd'], [h, 'h']] : h > 0 ? [[h, 'h'], [m, 'm']] : [[m, 'm']]
  return parts
    .filter(([n], i) => i === 0 || n > 0)
    .map(([n, u]) => `${n}${u}`)
    .join(' ')
}

/** Percent used: used/limit with a limit; the number itself when used + left make 100; else unknown. */
export function percentUsed(w: RouteQuotaWindow): number | null {
  if (w.used === null) return null
  if (w.limit !== null && w.limit > 0) return (w.used / w.limit) * 100
  const left = w.remaining ?? null
  if (left !== null && Math.abs(w.used + left - 100) <= 1.5) return w.used
  return null
}

const NOTES: Record<string, string> = {
  low: 'too little use yet to estimate tokens',
  new: 'window just started · no estimate yet',
  stale: 'usage too old to estimate tokens'
}

function leftLabel(w: RouteQuotaWindow, pct: number | null): string {
  const remaining = w.remaining ?? null
  if (w.unit && remaining !== null) return `${compactCount(remaining)} ${w.unit} left`
  if (pct !== null) return `${Math.round(w.limit === null && remaining !== null ? remaining : 100 - pct)}% left`
  if (w.display) return w.display
  return w.used === null ? '—' : String(w.used)
}

function tokensLabel(w: RouteQuotaWindow, pct: number | null): string | null {
  const spent = w.tokensUsed ?? null
  if (spent === null || pct === null || pct <= 0 || w.estimateWhy) return null
  const left = pct >= 100 ? 0 : (spent / (pct / 100)) * (1 - pct / 100)
  return `≈${compactCount(left)} tokens left · ${compactCount(spent)} used`
}

export function windowView(w: RouteQuotaWindow, now: number): WindowView {
  const pct = percentUsed(w)
  const value = w.valueUsed ?? null
  return {
    name: w.name,
    leftFill: pct === null ? null : Math.max(0, Math.min(1, 1 - pct / 100)),
    left: leftLabel(w, pct),
    resets: w.resetsAt === null ? null : w.resetsAt <= now ? 'resetting' : `resets in ${inDuration(w.resetsAt - now)}`,
    tokens: tokensLabel(w, pct),
    value: value === null ? null : `$${Math.round(value).toLocaleString('en-US')} at API prices`,
    note: w.estimateWhy ? (NOTES[w.estimateWhy] ?? `no token estimate (${w.estimateWhy})`) : null,
    hot: pct !== null && pct >= 90
  }
}

/** The account's own facts under its windows: reset credits, the plan's end, how old the reading is. */
export function quotaFacts(q: RouteQuota, now: number): string[] {
  const facts: string[] = []
  const credits = q.resetCredits ?? null
  if (credits) {
    const head = `${credits.count} reset${credits.count === 1 ? '' : 's'} in hand`
    const first = credits.firstExpiresAt
    facts.push(first !== null && first > now ? `${head} · first expires in ${inDuration(first - now)}` : head)
  }
  if (q.until != null) facts.push(`plan until ${new Date(q.until).toISOString().slice(0, 10)}`)
  if (q.readAt != null) facts.push(now - q.readAt < MIN ? 'read just now' : `read ${inDuration(now - q.readAt)} ago`)
  return facts
}

/** The MCP row's second line: what the hub hands every agent. */
export function mcpLibraryLine(servers: readonly string[] | null | undefined): string {
  if (servers == null) return "Magpie's library could not be read"
  if (servers.length === 0) return 'hub shares nothing yet · add servers in Magpie › Library'
  return `hub shares ${servers.join(', ')}`
}
