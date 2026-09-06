/**
 * Pure helpers for scripts/perf-eval.mjs — the live-machine perf eval.
 *
 * Plain ESM with no TypeScript imports on purpose: the runner is copied to
 * ~/.cookrew/bin by `npm run perf:install` and runs from launchd with no
 * repo checkout behind it. Everything here is a function of its arguments,
 * so tests/perf-eval-lib.test.ts can pin each one — including that
 * `percentiles` agrees with src/shared/stats.ts, which the product renders.
 */

const MB = 1024 * 1024

/**
 * Type-7 percentile summary (numpy default: rank = p/100 × (n-1), linear
 * interpolation). Same convention as latencyStats in src/shared/stats.ts;
 * the test suite asserts the two never drift. Empty input → null.
 */
export function percentiles(values) {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0)
  if (clean.length === 0) return null
  const sorted = clean.slice().sort((a, b) => a - b)
  const last = sorted.length - 1
  const at = (p) => {
    const rank = (p / 100) * last
    const lo = Math.floor(rank)
    const hi = Math.ceil(rank)
    return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo])
  }
  return { count: sorted.length, p50: at(50), p95: at(95), p98: at(98), max: sorted[last] }
}

/** 'ok' | 'warn' | 'fail' against { warn, fail } thresholds (either optional). */
export function judge(value, budget) {
  if (!budget || value === null || value === undefined || !Number.isFinite(value)) return 'ok'
  if (budget.fail !== undefined && value > budget.fail) return 'fail'
  if (budget.warn !== undefined && value > budget.warn) return 'warn'
  return 'ok'
}

/**
 * Least-squares slope of value over time, in units per hour. Null unless at
 * least three samples span thirty minutes — two points always make a line,
 * and a line through noise is how a "leak" gets reported that was a GC.
 */
export function slopePerHour(samples) {
  const pts = samples.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.value))
  if (pts.length < 3) return null
  const span = Math.max(...pts.map((p) => p.t)) - Math.min(...pts.map((p) => p.t))
  if (span < 30 * 60 * 1000) return null
  const n = pts.length
  const meanT = pts.reduce((s, p) => s + p.t, 0) / n
  const meanV = pts.reduce((s, p) => s + p.value, 0) / n
  const num = pts.reduce((s, p) => s + (p.t - meanT) * (p.value - meanV), 0)
  const den = pts.reduce((s, p) => s + (p.t - meanT) ** 2, 0)
  if (den === 0) return null
  return (num / den) * 60 * 60 * 1000
}

/**
 * The storage buckets a ~/.cookrew path falls into. Ordered: the first match
 * wins, so backup residue is named before the store it shadows.
 */
const BUCKETS = [
  ['backups', (p) => /(^|\/)[^/]+\.bak-[^/]+(\/|$)/.test(p) || /(^|\/)lineage-(restore-backup|postwrite-snapshot)-/.test(p)],
  ['session-backups', (p) => p.startsWith('session-backups/')],
  ['team-sidecars', (p) => /^teams\/[^/]+-sessions\//.test(p)],
  ['teams', (p) => p.startsWith('teams/')],
  ['served-sessions', (p) => p.startsWith('sessions/')],
  ['pi-sessions', (p) => p.startsWith('pi-sessions/')],
  ['turns', (p) => p.startsWith('turns/')],
  ['attachments', (p) => p.startsWith('attachments/')],
  ['events', (p) => /^events(\.\d+)?\.jsonl$/.test(p)],
  ['workspaces', (p) => p.startsWith('workspaces/')],
  ['annotations', (p) => p.startsWith('checkpoint-annotations/')],
  ['worktrees', (p) => p.startsWith('worktrees/')],
  ['registry', (p) => p.startsWith('registry/')],
  ['bin', (p) => p.startsWith('bin/')],
  ['perf-history', (p) => p.startsWith('perf-history/')]
]

export function bucketOf(relativePath) {
  const hit = BUCKETS.find(([, test]) => test(relativePath))
  return hit ? hit[0] : 'other'
}

/** entries: [{ path (relative, '/'-joined), bytes }] → { buckets, total }. */
export function bucketStorage(entries) {
  const buckets = {}
  let total = 0
  for (const { path, bytes } of entries) {
    const name = bucketOf(path)
    buckets[name] = (buckets[name] ?? 0) + bytes
    total += bytes
  }
  return { buckets, total }
}

/**
 * Sidecar files no team names. `teams` is [{ slug, sessions }] read from
 * teams/<slug>.json; `sidecars` is [{ slug, files: [{ name, bytes }] }] read
 * from teams/<slug>-sessions/. A sidecar with no team at all is wholly orphan.
 */
export function orphanSidecars(teams, sidecars) {
  const named = new Map(teams.map((t) => [t.slug, new Set(Object.values(t.sessions ?? {}))]))
  const orphans = []
  for (const { slug, files } of sidecars) {
    const keep = named.get(slug)
    for (const file of files) {
      if (keep && keep.has(file.name)) continue
      orphans.push({ slug, file: file.name, bytes: file.bytes, teamMissing: !keep })
    }
  }
  return orphans
}

/** ps etime: [[dd-]hh:]mm:ss → seconds. */
export function parseEtime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim())
  if (!m) return null
  const [, d = '0', h = '0', min, s] = m
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s)
}

const ROLE_BY_TYPE = { renderer: 'renderer', 'gpu-process': 'gpu', utility: 'utility', zygote: 'zygote' }

const isElectronBinary = (args) => /Electron(\.app| Helper)/.test(args) || /Cookrew\.app\/Contents/.test(args)

/**
 * The Cookrew app's own processes out of a `ps -Ao pid,ppid,rss,etime,args`
 * table, with a role each.
 *
 * The helpers name themselves: every one carries
 * `--user-data-dir=…/cookrew`. The main process does not — a dev checkout
 * runs as `…/Electron .` and says "cookrew" only if the directory happens
 * to — so it is found as the PARENT of a helper, which is what makes it the
 * main process. A headless Chrome the app drives and the eval itself are
 * excluded.
 */
export function pickAppProcesses(rows) {
  const electron = rows.filter((row) => isElectronBinary(row.args ?? '') && !/perf-eval/.test(row.args ?? ''))
  const helpers = new Set(electron.filter((row) => /--type=/.test(row.args) && /cookrew/i.test(row.args)))
  const mainPids = new Set([...helpers].map((row) => String(row.ppid)))
  const out = []
  for (const row of electron) {
    const type = /--type=([a-z-]+)/.exec(row.args)?.[1]
    const isMain = !type && (mainPids.has(String(row.pid)) || /Cookrew\.app\/Contents\/MacOS\/Cookrew/.test(row.args))
    if (!type && !isMain) continue
    if (type && !helpers.has(row)) continue
    const role = type ? (ROLE_BY_TYPE[type] ?? type) : 'main'
    out.push({ pid: Number(row.pid), role, rssMb: Number(row.rss) / 1024, uptimeSec: parseEtime(row.etime) ?? 0 })
  }
  return out
}

/** Parse `ps -Ao pid,ppid,rss,etime,args` output into rows. */
export function parsePsTable(text) {
  return text
    .split('\n')
    .slice(1)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, rss, etime, args]) => ({ pid, ppid, rss, etime, args }))
}

/**
 * Per-type latency percentiles from event-log lines (events*.jsonl), over
 * events at or after `since`. Only finite, non-negative durations count —
 * the same rule as isTimed in src/renderer/src/event-log.ts.
 */
export function latencyFromEvents(lines, since = 0) {
  const byType = {}
  for (const line of lines) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const { type, durationMs, timestamp } = event
    if (typeof type !== 'string' || typeof durationMs !== 'number') continue
    if (!Number.isFinite(durationMs) || durationMs < 0) continue
    if (typeof timestamp === 'number' && timestamp < since) continue
    ;(byType[type] ??= []).push(durationMs)
  }
  return Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, percentiles(values)]))
}

export const fmtMb = (bytes) => `${(bytes / MB).toFixed(1)} MB`
export const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : `${Math.round(ms)} ms`)

/** A fixed-width table: rows of strings, columns padded to the widest cell. */
export function renderTable(rows) {
  if (rows.length === 0) return ''
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c] ?? '').length)))
  return rows.map((r) => r.map((cell, c) => String(cell ?? '').padEnd(widths[c])).join('  ').trimEnd()).join('\n')
}

const MARK = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' }

export function renderSection(title, section) {
  const rows = section.checks.map((c) => [
    MARK[c.verdict],
    c.name,
    c.value === null || c.value === undefined ? '—' : `${c.value.toFixed(c.unit.startsWith('MB') ? 1 : 0)} ${c.unit}`,
    c.note ?? ''
  ])
  return `${title} — ${section.verdict.toUpperCase()}\n${renderTable(rows)}`
}

export function renderBuckets(buckets) {
  const rows = Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, bytes]) => ['    ', name, fmtMb(bytes), ''])
  return renderTable(rows)
}

/**
 * One run at a time. mkdir is atomic, so the directory is the lock; a lock
 * older than the longest possible run is a crash's leftover and is taken.
 */
const LOCK_STALE_MS = 45 * 60 * 1000

function acquireLock(dir) {
  const lock = path.join(dir, '.lock')
  mkdirSync(dir, { recursive: true })
  try {
    mkdirSync(lock)
    return () => rmSync(lock, { recursive: true, force: true })
  } catch {
    const age = Date.now() - statSync(lock).mtimeMs
    if (age < LOCK_STALE_MS) return null
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock)
    return () => rmSync(lock, { recursive: true, force: true })
  }
}

/** The worst verdict wins: fail > warn > ok. */
export function worstOf(verdicts) {
  if (verdicts.includes('fail')) return 'fail'
  if (verdicts.includes('warn')) return 'warn'
  return 'ok'
}
