import type { RouteModel, RouteQuota, RouteQuotaWindow } from '../../shared/route'

/**
 * THE CATALOG AND THE ALLOWANCES, AS COOKREW READS THEM (route program).
 *
 * /v1/models is the documented, stable face: `id` (`provider/model`, or a
 * routing group's `group/<id>`), `display_name`, `owned_by`, `reasoning`,
 * `supported_reasoning_levels` ([{effort}]), `context_window`. Groups come
 * first — a group is what the owner reaches for ("smart"), the members are
 * what it resolves to.
 *
 * /v1/magpie/quotas is documented in prose, not as a schema (reference.md,
 * "Connecting anything else"); the real answer on 2026-10-11 (0.1.1182) was
 * `{data: [{provider, name, kind, plan, user, windows: [{name, used,
 * remaining, limit, unit, display}], readAt, error?}]}`. The mapper takes
 * what a row has and leaves the rest null; a field it never saw is null,
 * never invented.
 *
 * 0.1.2597 (2026-11-03) says more, and the panel now shows it: a window's
 * `used`/`remaining` are PERCENTS when it has no `limit`, `resetsAt` is
 * real, `holds` is what the account spent in the window ({tokens, cost,
 * priced, since}) and `holdsWhy` why there is no such figure ("low", "new",
 * "stale"); a prepaid provider is `kind: "balance"` with a `balance`
 * sentence; Codex adds `until` (the plan's end) and `resets` (window resets
 * held: {count, until}).
 */

export interface CatalogFetch {
  (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A routing group: the id says so, or the label does. The real gateway
 * (0.1.1182) gives a group a MEMBER's provider as `owned_by` ("ollama" for
 * group/smart) and says "routing group" only in `magpie_label`, so the
 * owner alone is not the tell.
 */
export function isGroup(id: string, ownedBy: string | null, label: string | null = null): boolean {
  if (id.startsWith('group/')) return true
  if ((label ?? '').toLowerCase().includes('routing group')) return true
  const owner = (ownedBy ?? '').toLowerCase()
  return owner === 'group' || owner.includes('routing')
}

export function toRouteModel(row: unknown): RouteModel | null {
  const r = asRecord(row)
  const id = r ? str(r.id) : null
  if (!r || !id) return null
  const ownedBy = str(r.owned_by) ?? str(r.ownedBy) ?? (id.includes('/') ? id.split('/')[0] : 'magpie')
  const group = isGroup(id, ownedBy, str(r.magpie_label))
  const levelsRaw = Array.isArray(r.supported_reasoning_levels) ? r.supported_reasoning_levels : []
  const levels = levelsRaw
    .map((l) => (typeof l === 'string' ? l : str(asRecord(l)?.effort)))
    .filter((l): l is string => l !== null)
  return {
    id,
    displayName: str(r.display_name) ?? str(r.displayName) ?? id,
    ownedBy: group ? 'magpie' : ownedBy,
    group,
    reasoning: r.reasoning === true || levels.length > 0,
    levels,
    contextWindow: num(r.context_window) ?? num(r.context_length) ?? num(r.contextWindow)
  }
}

/** Groups first, then models in the catalog's own order. */
export function toCatalog(body: unknown): RouteModel[] {
  const b = asRecord(body)
  const rows = Array.isArray(body) ? body : Array.isArray(b?.data) ? (b!.data as unknown[]) : Array.isArray(b?.models) ? (b!.models as unknown[]) : []
  const models = rows.map(toRouteModel).filter((m): m is RouteModel => m !== null)
  return [...models.filter((m) => m.group), ...models.filter((m) => !m.group)]
}

/** Distinct providers behind the catalog; a group is not a provider. */
export function providersOf(models: readonly RouteModel[]): number {
  return new Set(models.filter((m) => !m.group).map((m) => m.ownedBy)).size
}

const resetAt = (v: unknown): number | null => {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function toWindow(name: string, row: unknown): RouteQuotaWindow {
  const r = asRecord(row)
  const holds = asRecord(r?.holds)
  return {
    name,
    used: num(r?.used) ?? num(r?.usedPercent) ?? num(r?.utilization) ?? null,
    limit: num(r?.limit) ?? num(r?.total) ?? null,
    resetsAt: resetAt(r?.resetsAt ?? r?.resets_at ?? r?.reset ?? r?.resetAt),
    display: str(r?.display),
    remaining: num(r?.remaining),
    unit: str(r?.unit),
    tokensUsed: num(holds?.tokens),
    // An unpriced spend has no dollar figure: null, never a zero.
    valueUsed: holds?.priced === true ? num(holds.cost) : null,
    since: resetAt(holds?.since),
    estimateWhy: str(r?.holdsWhy)
  }
}

function windowsOf(r: Record<string, unknown>): RouteQuotaWindow[] {
  const raw = r.windows ?? r.allowances ?? r.limits
  if (Array.isArray(raw)) {
    return raw.map((w, i) => toWindow(str(asRecord(w)?.name) ?? str(asRecord(w)?.window) ?? `window ${i + 1}`, w))
  }
  const rec = asRecord(raw)
  if (rec) return Object.entries(rec).map(([name, w]) => toWindow(name, w))
  return []
}

function kindOf(r: Record<string, unknown>, provider: string): RouteQuota['kind'] {
  const kind = (str(r.kind) ?? str(r.type) ?? '').toLowerCase()
  if (kind === 'key' || kind === 'api_key' || kind === 'apikey') return 'key'
  if (kind === 'local') return 'local'
  if (kind === 'balance' || kind === 'prepaid') return 'balance'
  if (kind === 'subscription' || kind === 'account') return 'subscription'
  // No kind said, but a balance given: a prepaid provider.
  if (str(r.balance)) return 'balance'
  if (/^(ollama|lmstudio|lm-studio|vllm|local)/i.test(provider)) return 'local'
  if (str(r.account) ?? str(r.user) ?? str(r.email) ?? str(r.login) ?? str(r.plan)) return 'subscription'
  return 'key'
}

export function toQuota(row: unknown): RouteQuota | null {
  const r = asRecord(row)
  if (!r) return null
  const provider = str(r.provider) ?? str(r.agent) ?? str(r.name) ?? str(r.id)
  if (!provider) return null
  return {
    provider,
    // The real quotas row says `user`; the docs say account/email/login.
    account: str(r.account) ?? str(r.user) ?? str(r.email) ?? str(r.login) ?? null,
    // The real row names the account's product in `name` ("Claude Code"); only when `provider` said who it is.
    alias: str(r.alias) ?? (str(r.provider) ? str(r.name) : null),
    plan: str(r.plan),
    kind: kindOf(r, provider),
    windows: windowsOf(r),
    last: r.last === true,
    error: str(r.error),
    balance: str(r.balance),
    until: resetAt(r.until),
    resetCredits: resetCreditsOf(r.resets),
    readAt: resetAt(r.readAt)
  }
}

function resetCreditsOf(v: unknown): RouteQuota['resetCredits'] {
  const r = asRecord(v)
  const count = num(r?.count)
  return count === null ? null : { count, firstExpiresAt: resetAt(r?.until) }
}

/**
 * A quota row for every catalog provider the gateway said nothing about.
 * Ollama never appears in /v1/magpie/quotas (nothing to allow, nothing to
 * read), yet the panel must list it as "Ollama · local"; a provider with
 * models but no row is a local or keyed source with no allowance to show.
 */
export function withLocalRows(quotas: readonly RouteQuota[], models: readonly RouteModel[]): RouteQuota[] {
  const seen = new Set(quotas.map((q) => q.provider.toLowerCase()))
  const extra: RouteQuota[] = []
  for (const m of models) {
    if (m.group) continue
    const key = m.ownedBy.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    extra.push({ provider: m.ownedBy, account: null, alias: null, plan: null, kind: kindOf({}, m.ownedBy), windows: [], last: false, error: null })
  }
  return [...quotas, ...extra]
}

export function toQuotas(body: unknown): RouteQuota[] {
  const b = asRecord(body)
  const rows = Array.isArray(body) ? body : Array.isArray(b?.quotas) ? (b!.quotas as unknown[]) : Array.isArray(b?.accounts) ? (b!.accounts as unknown[]) : Array.isArray(b?.data) ? (b!.data as unknown[]) : []
  return rows.map(toQuota).filter((q): q is RouteQuota => q !== null)
}

async function getJson(fetchFn: CatalogFetch, url: string, key: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${key}`, 'user-agent': 'cookrew' }, signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchCatalog(fetchFn: CatalogFetch, v1: string, key: string, timeoutMs = 4000): Promise<RouteModel[]> {
  return toCatalog(await getJson(fetchFn, `${v1}/models`, key, timeoutMs))
}

export async function fetchQuotas(fetchFn: CatalogFetch, url: string, key: string, timeoutMs = 4000): Promise<RouteQuota[]> {
  return toQuotas(await getJson(fetchFn, `${url}/v1/magpie/quotas`, key, timeoutMs))
}
