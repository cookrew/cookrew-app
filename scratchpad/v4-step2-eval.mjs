#!/usr/bin/env -S node_modules/.bin/vite-node

// V4 GATE — cross-workspace dispatch must be OBSERVABLE (G1) and FAITHFUL (G2).
//
// Run:
//   node_modules/.bin/vite-node scratchpad/v4-step2-eval.mjs
//   node_modules/.bin/vite-node scratchpad/v4-step2-eval.mjs --measure-only
//
// System-level TDD. G1 went GREEN when Sol's step 2 landed; G2 is the wave-B
// extension and is RED until a detached turn is traced as richly as a focused
// one (spec: scratchpad/e2e-loop-and-goals.html §3).
//
//   G1 — concurrency: a background turn in an INACTIVE workspace dispatches,
//        completes and traces, while focus never moves.
//        C1 activeId pinned · C2 dispatch reached · C3 no switches
//        C4 turn.completed carries durationMs
//
//   G2 — fidelity: the trace is not merely present but TRUE.
//        G2a durationMs is a real measurement of a known-length turn
//        G2b /api/activity carries a live row for each HOT target mid-turn
//
// WHY A KNOWN-LENGTH TURN: C4 only asks that durationMs exists. A field that is
// always 0 satisfies that and still tells you nothing — which is exactly what
// was measured at the G1 flip. G2a pins the number to something independently
// known by making the agent sleep for a fixed interval, so the only way to pass
// is to actually measure the turn.
//
// ONE DISPATCH SERVES BOTH. Every run of this gate prompts two live agents, so
// the sleep turn is also the C2/C4 turn rather than a second prompt.
//
// TWO DELIBERATE CHOICES, both from measurement rather than taste:
//
// 1. Dispatch does NOT use `herdr agent prompt --wait`. That flag returned
//    `agent_prompt_stalled` for BOTH targets while both prompts were delivered
//    and both agents answered correctly — the 5000ms state-change observer
//    never saw a transition. A gate trusting that exit status would report a
//    false failure and, on retry, double-prompt a live agent. Delivery is
//    confirmed by polling the pane for a per-run nonce instead.
//
// 2. Every run carries a unique nonce. Without it a stale reply from a previous
//    run reads as success, and this gate would go green on a corpse.

import { execFileSync } from 'node:child_process'

const MEASURE_ONLY = process.argv.includes('--measure-only')

/** The workspace that must stay active for the whole run. */
const EXPECTED_ACTIVE = '712d77f6-7f5b-42f9-a1d9-d735a468e2fa'

/** Both targets live in INACTIVE workspaces — that is the point of the gate. */
const TARGETS = [
  {
    label: 'A/Portfolio',
    pane: 'w1:p2E',
    terminalId: '82443e83-c6d1-4037-868b-f0eff8b5c77f',
    workspaceId: '1fb76d80-1913-43b5-8d00-1ef75b1b12ce'
  },
  {
    label: 'B/GOAT',
    pane: 'w1:pV',
    terminalId: 'd8bc2359-f8be-4abc-b685-696f084bb6c9',
    workspaceId: '74d86b39-a73e-4e34-b184-ecc7e12c12eb'
  }
]

/** The turn we ask for. Long enough to poll inside, short enough to be cheap. */
const SLEEP_S = 8
/**
 * Accepted band for durationMs of that turn. Wider than the sleep because a
 * turn is prompt-submit → reply-rendered, which carries model latency on both
 * ends; the floor is what rules out a stubbed 0 or a millisecond no-op.
 * (§3 states a tighter goal of real ±2s — worth tightening to once the number
 * is real and its jitter is known.)
 */
const DURATION_MIN_MS = 4_000
// Ceiling covers full agent wall-time around the 8s sleep (startup, tool
// call, reply) — measured real turns run 8-31s. The band's job is catching
// 0/undefined/fabricated values, not penalizing honest agent overhead
// (first GREEN run: Portfolio 8.2s in-band, GOAT 30.8s just over the old 30s cap).
const DURATION_MAX_MS = 90_000

const LEDGER_DEADLINE_MS = 120_000
const DELIVERY_DEADLINE_MS = 60_000
/** Mid-turn window: must cover the sleep plus the agent's ramp-up. */
const MIDTURN_DEADLINE_MS = 45_000
const POLL_MS = 3_000
/** Mid-turn polling is tight — an 8s window sampled every 3s could be missed. */
const MIDTURN_POLL_MS = 1_000

const BASE = 'https://127.0.0.1:8643'

// ---- token discipline -------------------------------------------------------
// The token is read once, never logged, and every string that leaves this
// process goes through redact() on the way out.
const TOKEN_RE = /token=[A-Za-z0-9_-]+/g
const redact = (s) => String(s).replace(TOKEN_RE, 'token=REDACTED')
let TOKEN = ''

const say = (s = '') => console.log(redact(s))

function acquireToken() {
  const out = execFileSync('node', ['cli/cookrew.mjs', 'mobile'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const m = out.match(/token=([A-Za-z0-9_-]+)/)
  if (!m) throw new Error('could not obtain a pairing token from `cookrew mobile`')
  return m[1]
}

function api(path) {
  const raw = execFileSync(
    'curl',
    ['-sk', '--max-time', '20', `${BASE}${path}`, '-H', `Authorization: Bearer ${TOKEN}`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`non-JSON from ${path}: ${redact(raw).slice(0, 200)}`)
  }
}

function apiPost(path, body) {
  const raw = execFileSync(
    'curl',
    [
      '-sk', '--max-time', '20', '-X', 'POST', `${BASE}${path}`,
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body),
      '-w', '\n%{http_code}'
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  )
  const idx = raw.lastIndexOf('\n')
  return { status: Number(raw.slice(idx + 1).trim()), body: raw.slice(0, idx) }
}

function herdr(args) {
  try {
    return execFileSync('herdr', args, {
      encoding: 'utf8',
      env: { ...process.env, HERDR_SESSION: 'cookrew' },
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    // `agent prompt` exits non-zero on a stalled WAIT even when the prompt
    // landed, so a throw here is data, not a reason to abort the run.
    return String(error.stdout ?? '') + String(error.stderr ?? '')
  }
}

function paneText(pane) {
  const raw = herdr(['pane', 'read', pane])
  try {
    const d = JSON.parse(raw)
    return d?.result?.text ?? d?.text ?? raw
  } catch {
    return raw
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- checks -----------------------------------------------------------------
const results = []
const check = (id, label, ok, detail = '') => {
  results.push({ id, label, ok, detail })
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${label}${detail ? `  — ${detail}` : ''}`)
}

/** Restore is in a finally: a failed assertion must not leave workspaces HOT. */
function setServiceState(state) {
  const out = []
  for (const t of TARGETS) {
    const r = apiPost(`/api/workspaces/${t.workspaceId}/service`, { state })
    out.push(`${t.label}=${r.status}`)
  }
  return out.join(' ')
}

async function run() {
  say('V4 GATE — G1 concurrency + G2 fidelity')
  say(MEASURE_ONLY ? '(measure-only: reporting, never failing)' : '')

  TOKEN = acquireToken()
  const nonce = `V4E${Date.now().toString(36).toUpperCase()}`
  const T0 = Date.now()

  const before = api('/api/workspaces')
  say(`  T0=${T0}  nonce=${nonce}  sleep=${SLEEP_S}s`)
  say(`  activeId at start: ${before.activeId}`)

  check('C1', 'activeId pinned to Cookrew Dev at start', before.activeId === EXPECTED_ACTIVE, before.activeId)

  say(`\n  marking targets HOT: ${setServiceState('hot')}`)

  try {
    // ---- dispatch a KNOWN-LENGTH turn --------------------------------------
    say('  dispatching sleep-turn (herdr-native, no --wait; see header)…')
    const dispatchedAt = Date.now()
    for (const t of TARGETS) {
      const text =
        `Run exactly this one bash command and nothing else, then stop: sleep ${SLEEP_S} && echo ${nonce}`
      const out = herdr(['agent', 'prompt', t.pane, text])
      const stalled = out.includes('agent_prompt_stalled')
      say(`    ${t.label} ${t.pane}: submitted${stalled ? ' (wait-observer stalled — expected)' : ''}`)
    }

    // ---- G2b + C2 in ONE tight loop ----------------------------------------
    // The mid-turn window is only ~8s wide, so this polls every second and
    // records the first sighting of each signal rather than sampling once.
    const midturn = new Map(TARGETS.map((t) => [t.label, null]))
    const delivered = new Map(TARGETS.map((t) => [t.label, false]))
    const deadline = dispatchedAt + Math.max(MIDTURN_DEADLINE_MS, DELIVERY_DEADLINE_MS)

    while (Date.now() < deadline) {
      const withinMidturn = Date.now() < dispatchedAt + MIDTURN_DEADLINE_MS
      if (withinMidturn) {
        let acts = []
        try {
          acts = api('/api/activity')
        } catch {
          acts = []
        }
        for (const t of TARGETS) {
          if (midturn.get(t.label)) continue
          const row = acts.find((a) => a.terminalId === t.terminalId)
          if (row) midturn.set(t.label, { phase: row.phase, at: Date.now() - dispatchedAt })
        }
      }
      for (const t of TARGETS) {
        if (delivered.get(t.label)) continue
        if (paneText(t.pane).includes(nonce)) delivered.set(t.label, true)
      }
      const allDone =
        [...delivered.values()].every(Boolean) && [...midturn.values()].every((v) => v !== null)
      if (allDone) break
      await sleep(MIDTURN_POLL_MS)
    }

    say('')
    for (const t of TARGETS) {
      check(
        'C2',
        `dispatch reached ${t.label} (${t.pane})`,
        delivered.get(t.label) === true,
        delivered.get(t.label) ? 'nonce echoed in pane' : 'nonce never appeared'
      )
    }
    for (const t of TARGETS) {
      const m = midturn.get(t.label)
      check(
        'G2b',
        `/api/activity live row for HOT ${t.label} mid-turn`,
        m !== null,
        m ? `phase=${m.phase} at +${m.at}ms` : 'no activity row during the turn'
      )
    }

    // ---- C4 + G2a ----------------------------------------------------------
    say(`\n  waiting up to ${LEDGER_DEADLINE_MS / 1000}s for turn.completed…`)
    const seen = new Map(TARGETS.map((t) => [t.terminalId, null]))
    const ledgerEnd = Date.now() + LEDGER_DEADLINE_MS
    while (Date.now() < ledgerEnd) {
      const events = api(`/api/events/query?type=turn.completed&since=${T0}`)
      const list = Array.isArray(events) ? events : (events.events ?? [])
      for (const e of list) {
        if (seen.has(e.entityId) && seen.get(e.entityId) === null) seen.set(e.entityId, e)
      }
      if ([...seen.values()].every((v) => v !== null)) break
      await sleep(POLL_MS)
    }

    say('')
    for (const t of TARGETS) {
      const e = seen.get(t.terminalId)
      const hasDuration = e !== null && Number.isFinite(e.durationMs) && e.durationMs >= 0
      check(
        'C4',
        `turn.completed with durationMs for ${t.label}`,
        hasDuration,
        e === null ? 'no turn.completed event' : `durationMs=${e.durationMs}`
      )
    }
    for (const t of TARGETS) {
      const e = seen.get(t.terminalId)
      const d = e?.durationMs
      const inBand = Number.isFinite(d) && d >= DURATION_MIN_MS && d <= DURATION_MAX_MS
      check(
        'G2a',
        `durationMs of the ${SLEEP_S}s turn is real for ${t.label}`,
        inBand,
        e === null
          ? 'no event'
          : `durationMs=${d} (want ${DURATION_MIN_MS}..${DURATION_MAX_MS})`
      )
    }

    // ---- the run must not have moved the world -----------------------------
    const after = api('/api/workspaces')
    check('C3a', 'activeId unchanged at end', after.activeId === EXPECTED_ACTIVE, after.activeId)

    const switched = api(`/api/events/query?type=workspace.switched&since=${T0}`)
    const switchedList = Array.isArray(switched) ? switched : (switched.events ?? [])
    check('C3b', 'zero workspace.switched during the run', switchedList.length === 0, `count=${switchedList.length}`)
  } finally {
    say(`\n  restoring dormant: ${setServiceState('dormant')}`)
  }

  // ---- verdict --------------------------------------------------------------
  const g1 = results.filter((r) => r.id.startsWith('C'))
  const g2 = results.filter((r) => r.id.startsWith('G2'))
  const failed = results.filter((r) => !r.ok)
  say('')
  say(`  G1 ${g1.filter((r) => r.ok).length}/${g1.length}   G2 ${g2.filter((r) => r.ok).length}/${g2.length}   overall ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    say('  failing:')
    for (const f of failed) say(`    ${f.id} ${f.label} — ${f.detail}`)
  }

  if (MEASURE_ONLY) {
    say('\nV4 GATE: MEASURE-ONLY (exit 0 regardless)')
    process.exit(0)
  }
  say(`\nV4 GATE: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(redact(`V4 GATE ERROR: ${error?.message ?? error}`))
  process.exit(2)
})
