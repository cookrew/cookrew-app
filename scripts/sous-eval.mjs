// THE EVALUATION THAT DECIDES THE THRESHOLDS (design §6 and §12 J3) — read-only, over the
// Sous ledger as it is actually written today.
//
//   node scripts/sous-eval.mjs [path] [--band=mode|exposure|domain] [--json]
//
// Default path ~/.cookrew/sous-decisions.jsonl. The file is opened READ-ONLY and never written,
// moved or truncated: it is the owner's record and the inbox's RETRY source.
//
// WHAT A BAND IS HERE. The design bands by Jev's confidence (≥0.85 / 0.5–0.85 / <0.5, with a
// second gate on top-2 margin). The shipped row schema (src/main/sous-ledger.ts) carries no
// confidence and no Jev answers at all, so banding by confidence would be inventing numbers. The
// band is `mode` instead — which is what those confidence bands RESOLVE to in the product
// (ticking / paused / question / answer) — and `--band=exposure` or `--band=domain` regroups the
// same arithmetic. When the Jev answers land in the ledger, add 'confidence' to BANDS and nothing
// else here changes.
//
// WHAT CANNOT BE COMPUTED YET is said out loud rather than printed as a zero (design §6 asks for
// four numbers and the schema supports two of them):
//   · completion       — needs the completion Noul, which needs Jev. NOT MEASURED.
//   · Jev vs draft0    — the ledger records neither the Jev answers nor the rule draft. NOT MEASURED.
// A zero in either place would read as "perfect agreement" or "nothing completes", and both are
// lies about a column that does not exist.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.some((a) => a === `--${name}`)
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const FILE = args.find((a) => !a.startsWith('--')) ?? path.join(homedir(), '.cookrew', 'sous-decisions.jsonl')
const BAND = option('band', 'mode')
/** A hold this short, with nobody ever saying no, is decoration rather than a decision. */
export const THEATRE_MS = 300

const BANDS = {
  mode: (d) => d.mode ?? '(none)',
  exposure: (d) => `exposure ${d.exposure ?? '?'}`,
  domain: (d) => d.domain ?? '(none)'
}

/**
 * The ledger folds by token — the newest row wins field by field — but the FOLD IS NOT ENOUGH for
 * this report: "the owner picked a different target" and "the owner edited the brief" are visible
 * only in the difference between a token's first row and its last. So each token keeps both, plus
 * the row on which the owner first answered.
 */
export function readDecisions(text) {
  const byToken = new Map()
  let lines = 0
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    lines += 1
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      skipped += 1
      continue
    }
    if (!row || typeof row.token !== 'string') {
      skipped += 1
      continue
    }
    // An EXPIRY is the clock, not the owner: it never enters "time to ↵ or to commit".
    const answered = (r) => (r.ownerResponse && r.ownerResponse !== 'expired' ? r.updatedAt ?? r.at : null)
    const seen = byToken.get(row.token)
    if (!seen) {
      byToken.set(row.token, { first: { ...row }, folded: { ...row }, answeredAt: answered(row), rows: 1 })
      continue
    }
    seen.rows += 1
    // field by field, exactly as the ledger folds on read
    for (const [k, v] of Object.entries(row)) if (v !== undefined) seen.folded[k] = v
    if (seen.answeredAt === null) seen.answeredAt = answered(row)
  }
  return { decisions: [...byToken.values()], lines, skipped }
}

const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}
const pct = (n, of) => (of === 0 ? null : Math.round((n / of) * 1000) / 10)

/** The owner said no, or changed the brief before answering: either way the decision was re-made. */
export function reDecided(d) {
  if (d.folded.ownerResponse === 'cancel') return true
  const was = d.first.sentence ?? null
  const now = d.folded.sentence ?? null
  if (was !== null && now !== null && was !== now) return true
  // A proposal rewritten before delivery is an edit; one rewritten after is the Boundaries line.
  const p0 = d.first.proposalText ?? null
  const p1 = d.folded.proposalText ?? null
  return p0 !== null && p1 !== null && p0 !== p1
}

/** The owner sent it somewhere else than the card the echo named. */
export function substituted(d) {
  const from = d.first.target?.id ?? null
  const to = d.folded.target?.id ?? null
  return from !== null && to !== null && from !== to
}

/**
 * Time from the decision being minted to the owner ANSWERING it, in ms; null when they never did.
 * An `expired` response is not an answer — the hold ran out — so it is excluded rather than
 * counted as a very patient owner (readDecisions drops it).
 */
export function heldMs(d) {
  if (d.answeredAt === null || typeof d.first.at !== 'number') return null
  const ms = d.answeredAt - d.first.at
  return ms >= 0 ? ms : null
}

const isRecruit = (d) => (d.folded.target?.id ?? '').startsWith('harness:')

export function summarise(decisions) {
  const bandOf = BANDS[BAND] ?? BANDS.mode
  const bands = new Map()
  for (const d of decisions) {
    const key = bandOf(d.folded)
    if (!bands.has(key)) bands.set(key, [])
    bands.get(key).push(d)
  }
  const band = [...bands.entries()]
    .map(([name, ds]) => {
      const holds = ds.map(heldMs).filter((ms) => ms !== null)
      const rejects = ds.filter((d) => d.folded.ownerResponse === 'cancel').length
      const held = median(holds)
      return {
        band: name,
        count: ds.length,
        reDecideRate: pct(ds.filter(reDecided).length, ds.length),
        substitutionRate: pct(ds.filter(substituted).length, ds.length),
        medianHoldMs: held,
        answered: holds.length,
        rejects,
        // "Theatre": the hold looks like a decision point and never is one.
        theatre: held !== null && held < THEATRE_MS && rejects === 0
      }
    })
    .sort((a, b) => b.count - a.count || a.band.localeCompare(b.band))

  const count = (pick) => {
    const out = new Map()
    for (const d of decisions) {
      const key = pick(d)
      out.set(key, (out.get(key) ?? 0) + 1)
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  }

  return {
    decisions: decisions.length,
    band: BAND,
    bands: band,
    askVsRecruit: { recruit: decisions.filter(isRecruit).length, ask: decisions.filter((d) => !isRecruit(d) && d.folded.target).length, neither: decisions.filter((d) => !d.folded.target).length },
    domains: count((d) => d.folded.domain ?? '(none)'),
    exposure: count((d) => d.folded.exposure ?? '?'),
    ownerResponse: count((d) => d.folded.ownerResponse ?? '(none)'),
    outcomes: count((d) => d.folded.outcome ?? '(none)'),
    dismissed: decisions.filter((d) => d.folded.dismissed === true).length,
    notMeasured: {
      completion: 'needs the completion Noul (Jev); the ledger has no completion column',
      jevVsDraft0: 'the ledger records neither the Jev answers nor the rule draft'
    }
  }
}

function render(s, file, lines, skipped) {
  const out = []
  const row = (...cells) => out.push(cells.join(''))
  const pad = (v, w) => String(v).padEnd(w)
  const num = (v, w) => String(v === null ? '—' : v).padStart(w)
  row(`SOUS EVAL · ${file}`)
  row(`${lines} lines → ${s.decisions} decisions${skipped > 0 ? ` · ${skipped} unreadable lines skipped` : ''}`)
  row('')
  row(`BY ${s.band.toUpperCase()}`)
  row(`  ${pad('band', 14)}${num('n', 5)}${num('re-decide', 11)}${num('substitut.', 12)}${num('median ↵', 10)}${num('answered', 10)}${num('rejects', 9)}  theatre`)
  for (const b of s.bands) {
    row(
      `  ${pad(b.band, 14)}${num(b.count, 5)}${num(b.reDecideRate === null ? '—' : `${b.reDecideRate}%`, 11)}${num(
        b.substitutionRate === null ? '—' : `${b.substitutionRate}%`,
        12
      )}${num(b.medianHoldMs === null ? '—' : `${b.medianHoldMs} ms`, 10)}${num(b.answered, 10)}${num(b.rejects, 9)}  ${b.theatre ? 'THEATRE' : '·'}`
    )
  }
  row('')
  row(`ASK vs RECRUIT    ask ${s.askVsRecruit.ask} · recruit ${s.askVsRecruit.recruit}${s.askVsRecruit.neither > 0 ? ` · no target ${s.askVsRecruit.neither}` : ''}`)
  row(`DOMAIN            ${s.domains.map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  row(`EXPOSURE          ${s.exposure.map(([k, v]) => `${k}: ${v}`).join(' · ')}`)
  row(`OWNER RESPONSE    ${s.ownerResponse.map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  row(`OUTCOME           ${s.outcomes.map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  row(`DISMISSED         ${s.dismissed}`)
  row('')
  row('completion:       not measured — needs the completion Noul (Jev); the ledger has no completion column')
  row('Jev vs draft0:    not measured — the ledger records neither the Jev answers nor the rule draft')
  row('')
  row(`A band is THEATRE when its median hold is under ${THEATRE_MS} ms and nobody ever said no:`)
  row('the pause looks like a decision point and has never once been used as one.')
  return out.join('\n')
}

function main() {
  let text
  try {
    text = readFileSync(FILE, 'utf8')
  } catch (e) {
    process.stdout.write(`SOUS EVAL · ${FILE}\nno ledger to read (${e.code ?? 'unreadable'}) — nothing has been decided on this machine yet.\n`)
    return
  }
  const { decisions, lines, skipped } = readDecisions(text)
  const s = summarise(decisions)
  if (flag('json')) {
    process.stdout.write(`${JSON.stringify({ file: FILE, lines, skipped, ...s }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${render(s, FILE, lines, skipped)}\n`)
}

// Importable for the test, runnable for a person.
if (import.meta.url === `file://${process.argv[1]}`) main()
