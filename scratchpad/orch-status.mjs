#!/usr/bin/env node
// orch-status.mjs — reliable turn-state for orchestrated agent panes.
//
//   node scratchpad/orch-status.mjs status <pane...> [--table] [--fast] [--lines N]
//   node scratchpad/orch-status.mjs wait   <pane...> [--timeout ms] [--settle ms] [--table]
//
// Panes may be given as herdr pane IDs (w1:p7A) or as live agent titles (Forge).
// Dependencies: node stdlib + the `herdr` CLI. Nothing is ever sent to a pane.
//
// ---------------------------------------------------------------------------
// WHAT HERDR GIVES YOU NATIVELY  (verified against herdr 0.8.0, protocol 19)
// ---------------------------------------------------------------------------
// `herdr agent list`            One call, every agent: pane_id, title, agent kind,
//                               agent_status, cwd/foreground_cwd, terminal_title,
//                               revision, state_change_seq, focused. Cheap. USE IT
//                               for identity — just not for `agent_status`.
// `herdr agent explain <pane>`  The single most useful native call. Returns the
//                               detection *rule* that produced agent_status, plus
//                               `evidence`, or `fallback_reason`. This is how you
//                               learn that a status is a guess (see traps).
// `herdr pane read <pane>`      Four sources: visible | recent | recent-unwrapped |
//                               detection. `--format ansi` keeps SGR styling, which
//                               is the only way to tell a real composer entry from
//                               a dim placeholder. This is the ground truth.
// `herdr pane wait-output ...`  Server-side BLOCKING regex/substring match on a pane
//                               snapshot, with a timeout. Genuinely push-based: a
//                               working pane costs zero polls until the text appears.
//                               This tool uses it as a wakeup, never as a verdict.
// `herdr pane get <pane>`       Adds `scroll` {offset_from_bottom, max_offset_from_bottom,
//                               viewport_rows}. Useful to detect a human scrolled up.
//
// Reachable only over the socket (`herdr status server` → .sock), not the CLI:
//   events.subscribe   pane.updated | pane.output_matched | pane.agent_status_changed
//                      | pane.scroll_changed
//   events.wait        blocking single-event wait
// Both were investigated and are NOT used here — see traps 3 and 4.
//
// ---------------------------------------------------------------------------
// WHAT THIS TOOL DERIVES (because herdr cannot)
// ---------------------------------------------------------------------------
// Everything in `state`. herdr's agent detection is a priority-ranked rule list
// loaded from ~/.local/state/herdr/agent-detection/remote/<kind>.toml. For the
// three UIs we orchestrate, those rules cannot see a turn boundary (trap 1), so
// this tool parses the pane's own bottom-of-screen chrome instead:
//
//   claude  working     spinner line above the composer: "<glyph> Verbing… (4m 0s · ↓ 13.9k tokens)"
//           turn ended  "✻ Verbed for 14m 12s"   (past tense + " for " — note the
//                       contrast with the gerund+"…" of the live spinner)
//           composer    prompt box body, lines after "❯" between two ─── rules
//   codex   working     "• Working (12s • Esc to interrupt)" | braille spinner
//           composer    "› " line; the rotating hint is wrapped in SGR 2 (dim)
//           footer      "gpt-5.6-sol xhigh · ~/workspace/cookrew-dev"
//   pi      working     "⠋ Working..."  (bottom region only — see trap 2)
//           composer    lines between the last two ─── rules
//
// States reported: working | idle | input-pending | queued-message.
//   input-pending  = not working, but something is sitting unsent in the composer
//                    (typed text, "[Pasted text #1 +40 lines]") or an approval
//                    prompt is up. Either way: it is waiting on a human.
//   queued-message = working AND the composer is non-empty; that text will be
//                    submitted the moment the current turn ends.
//
// ---------------------------------------------------------------------------
// TRAPS
// ---------------------------------------------------------------------------
// 1. agent_status LIES, and `agent explain` tells you exactly why.
//    claude.toml's only "working" rules are `osc_title_working` (a braille or
//    half-circle glyph at the start of the OSC terminal title) and a /btw overlay.
//    Cookrew-spawned claude panes never emit that title — `terminal_title` stays
//    "clear; exec sh " — so nothing outranks `live_prompt_box` (priority 950),
//    which fires on the "❯" that Claude Code renders AT ALL TIMES, including
//    mid-turn. Result: a busy claude pane reports `idle` forever. Observed live:
//    a pane rendering "· Warping… (4m 0s · ↓ 13.9k tokens)" explained as
//    `state: idle, rule: live_prompt_box, evidence: "❯\n"`.
//    codex is worse in a quieter way: `rule: none`,
//    `fallback_reason: default_known_agent_idle_fallback` — herdr matched nothing
//    at all and defaulted to idle. Treat `rule: none` as "no opinion", not "idle".
//    Consequence: `herdr agent wait` returns instantly for a room full of busy
//    agents. This tool never consults agent_status for a verdict; it reports it
//    under `evidence.herdr` purely so you can see the disagreement.
//
// 2. pi's working rule is a whole-buffer substring.
//    pi.toml is one rule: contains "Working..." over region `whole_recent`. Any
//    scrollback that merely quotes the string pins pi at `working` indefinitely.
//    This tool matches "⠋ Working..." only in the bottom chrome region.
//
// 3. events.subscribe REPLAYS HISTORY on connect.
//    Subscribing to `pane.updated` immediately replays every pane's revision
//    history from revision 1, chronologically, ~110ms apart — 7+ seconds of
//    backlog on this session before a single live event arrives, each carrying a
//    stale `agent_status: "unknown"`. Same shape as the /api/events SSE 10-second
//    replay. If you ever use it, discard everything until the backlog drains.
//
// 4. events.wait only supports one match type.
//    `events.wait` with `pane_output_changed` returns
//    `unsupported_event_wait_match: "events.wait currently supports pane agent
//    status matches"`. The only supported match is pane_agent_status_changed —
//    i.e. the one signal that lies. Do not build on it.
//
// 5. `revision` is not an output counter.
//    `pane.read` results carry `revision: 0` on every source, always. `pane.get`'s
//    `revision` counts pane *metadata* changes (it sits at 3–4 for the whole life
//    of a pane) and `state_change_seq` only moves when agent_status moves — which,
//    per trap 1, it does not. There is no cheap content-free change counter.
//
// 6. The socket is one request per connection.
//    The herdr API socket answers exactly one request and closes. A second write
//    on the same connection is silently dropped. (Not an issue for CLI users.)
//
// 7. wait-output matches text you yourself printed.
//    `pane wait-output` searches the snapshot, so it matches output that already
//    exists — including this tool's own JSON scrolling through the pane it is
//    being run from. Observed live: waiting on my own pane for `✻ \w+ for `
//    matched `"matched_line":"✻ Churned for 14m` — my own console output for a
//    different pane. Mitigations here: a wait-output hit is only a WAKEUP that
//    triggers a structural re-read, never a verdict; and the caller's own pane
//    ($HERDR_PANE_ID) is polled instead of waited on.
//
// 8. Empty `cookrew ask` captures are not idleness.
//    A dispatch that returns no captured text says nothing about the agent — the
//    pane may be mid-render. Classify the pane; do not infer from the ask result.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)

const HERDR = process.env.HERDR_BIN || 'herdr'
const SELF_PANE = process.env.HERDR_PANE_ID || null
const DEFAULT_LINES = 60

// --- herdr CLI -------------------------------------------------------------

/**
 * Run a herdr subcommand. herdr reports server errors as JSON on stderr with
 * exit 1, so a non-zero exit is not automatically fatal.
 */
async function herdr(args, { timeout = 30_000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(HERDR, args, { timeout, maxBuffer: 32 * 1024 * 1024 })
      return { ok: true, stdout }
    } catch (error) {
      // A herdr *server* error is JSON on stderr with exit 1 and is a real answer.
      // A spawn/EAGAIN/timeout failure has no payload and is worth one retry: a
      // fan-out over 30-odd panes can briefly exhaust process slots.
      const payload = `${error.stderr || ''}${error.stdout || ''}`
      if (payload.trim()) return { ok: false, stdout: payload }
      if (attempt >= retries) throw new Error(`herdr ${args.join(' ')} failed: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

/** Run `task` over `items` with at most `limit` in flight — herdr is one process per call. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function herdrJson(args, options) {
  const { stdout } = await herdr(args, options)
  const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'))
  if (!line) throw new Error(`herdr ${args.join(' ')}: no JSON in output`)
  return JSON.parse(line)
}

async function listAgents() {
  const response = await herdrJson(['agent', 'list'])
  return response.result?.agents ?? []
}

async function readPane(paneId, { source = 'visible', lines = DEFAULT_LINES, ansi = true } = {}) {
  const args = ['pane', 'read', paneId, '--source', source, '--lines', String(lines)]
  if (ansi) args.push('--format', 'ansi')
  const { stdout } = await herdr(args)
  if (stdout.trimStart().startsWith('{"error"')) return null
  return stdout
}

/** The native rule that produced agent_status — or the reason there wasn't one. */
async function explainAgent(paneId) {
  const { stdout } = await herdr(['agent', 'explain', paneId])
  if (stdout.trimStart().startsWith('{')) return null
  const fields = {}
  for (const line of stdout.split('\n')) {
    const match = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (match) fields[match[1]] = match[2]
  }
  return fields
}

// --- terminal text ---------------------------------------------------------

const SGR = /\x1b\[[0-9;:]*m/g
const ANSI_ANY = /\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

const stripAnsi = (text) => text.replace(ANSI_ANY, '')

/**
 * Split a raw ANSI pane read into per-line {text, bright}, where `bright` is the
 * line's text with every SGR-2 (dim) run removed. Both codex and claude render
 * their rotating composer hint dim — "› Run /review on my current changes" is a
 * placeholder nobody typed — while the prompt glyph itself stays bright, so the
 * dim/bright split has to be per-run, not per-line.
 */
export function parseLines(raw) {
  return raw.split('\n').map((rawLine) => {
    const clean = (value) => stripAnsi(value).replace(/\r/g, '')
    let dim = false
    let cursor = 0
    let bright = ''
    for (const match of rawLine.matchAll(SGR)) {
      if (!dim) bright += clean(rawLine.slice(cursor, match.index))
      const codes = match[0].slice(2, -1).split(/[;:]/).filter(Boolean)
      if (codes.length === 0 || codes.includes('0') || codes.includes('22')) dim = false
      if (codes.includes('2')) dim = true
      cursor = match.index + match[0].length
    }
    if (!dim) bright += clean(rawLine.slice(cursor))
    return { text: clean(rawLine).trimEnd(), bright: bright.trimEnd() }
  })
}

// Claude Code prints the current git branch inside the prompt box's top rule
// ("────── branch-cleanup-and-reorg ──"), so a rule is "mostly box-drawing", not
// "only box-drawing".
const isRule = (text) => /[─━═]{10,}/.test(text) && text.replace(/[─━═\s]/g, '').length <= 40
const isBlank = (text) => !text.trim()

// --- UI grammars -----------------------------------------------------------

// A live claude spinner: gerund + ellipsis + an elapsed clock in parens.
// "· Warping… (4m 0s · ↓ 13.9k tokens)"  /  "✳ Thinking… (12s · esc to interrupt)"
const CLAUDE_WORKING = [
  /\S…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/,
  /\(\s*esc to interrupt/i,
]
// Turn-ended summary: past tense + " for " + duration. "✻ Churned for 14m 12s"
const CLAUDE_TURN_ENDED = /^\s*[✻✳✽*]\s+\S+\s+for\s+(?:\d+h\s*)?(?:\d+m\s*)?\d+s/

const CODEX_WORKING = [
  /^\s*[•◦]\s+Working\s*\(/i,
  /(?:^|\s)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|$)/,
  /\besc to interrupt\b/i,
]
const PI_WORKING = [/(?:^|\s)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Working\.\.\./]

// Lifted from herdr's own manifests, which get these right — approval UIs are
// real on-screen text, so herdr's blocked rules are trustworthy.
const BLOCKED_PATTERNS = [
  /do you want to proceed\?/i,
  /press enter to confirm or esc to cancel/i,
  /enter to submit answer/i,
  /allow command\?/i,
  /waiting for permission/i,
  /\[y\/n\]/i,
  /run a dynamic workflow\?/i,
]

const UNSUBMITTED_ATTACHMENT = /\[(?:Pasted text|Image|Audio|\.\.\.Truncated text)\s*#\d+(?:\s*\+\d+\s*lines)?\.*\]/

/** Trailing chrome that lives below/around the composer and is never user input. */
const CHROME = [
  /⏵⏵/,
  /shift\+tab to cycle/i,
  /^\s*new task\?/i,
  /\/clear to save/i,
  /^\s*\?\s*for shortcuts/i,
  /^[↑↓]\d|R\d+M|CH\d/,
  /^\s*~?\/.*\(\w[\w./-]*\)\s*$/,
  /·\s+~\//,
  /^\s*\(\w+\)\s+\w+\s*$/,
]
const isChrome = (text) => CHROME.some((pattern) => pattern.test(text))

// --- structural classifier -------------------------------------------------

/** Up to `count` non-blank lines immediately above `index`. */
function linesAbove(lines, index, count = 4) {
  const region = []
  for (let cursor = index - 1; cursor >= 0 && region.length < count; cursor -= 1) {
    if (!isBlank(lines[cursor].text)) region.push(lines[cursor])
  }
  return region
}

const CODEX_FOOTER = /·\s+~?\//

/**
 * Locate the composer and the status line(s) immediately above it.
 *
 * claude and pi both fence the composer between two horizontal rules:
 *
 *     <status line>          <- spinner while working, "✻ … for …" once ended
 *     ────── branch ──       <- openRule (claude hides the git branch in it)
 *     ❯ typed text
 *     ─────────────────      <- closeRule
 *     <footer>
 *
 * codex draws no box at all — just a "› " line above a "<model> · <cwd>" footer:
 *
 *     • Working (12s • Esc to interrupt)
 *     › typed text
 *       gpt-5.6-sol xhigh · ~/workspace/cookrew-dev
 *
 * Anchoring on the bottom chrome — rather than searching the buffer — is what
 * keeps the classifier immune to trap 7: transcript text scrolling past above
 * the composer can never be mistaken for the live status line.
 */
function locate(lines, kind) {
  if (kind === 'codex') {
    let composerIndex = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^\s*›/.test(lines[index].text)) {
        composerIndex = index
        break
      }
    }
    if (composerIndex < 0) return null
    let end = lines.length
    for (let index = composerIndex + 1; index < lines.length; index += 1) {
      if (CODEX_FOOTER.test(lines[index].text)) {
        end = index
        break
      }
    }
    return { status: linesAbove(lines, composerIndex), composer: lines.slice(composerIndex, end) }
  }

  const ruleIndexes = lines.map(({ text }, index) => (isRule(text) ? index : -1)).filter((index) => index >= 0)
  if (ruleIndexes.length < 2) return null
  const closeRule = ruleIndexes[ruleIndexes.length - 1]
  const openRule = ruleIndexes[ruleIndexes.length - 2]
  if (closeRule - openRule < 1) return null
  return { status: linesAbove(lines, openRule), composer: lines.slice(openRule + 1, closeRule) }
}

/** Composer content with dim placeholders, prompt glyphs and chrome removed. */
function composerContent(composer) {
  const entries = []
  for (const { bright } of composer) {
    if (isBlank(bright) || isChrome(bright)) continue
    const body = bright.replace(/^\s*[❯›>]\s?/, '').trim()
    if (body) entries.push(body)
  }
  return entries
}

const WORKING_PATTERNS = { claude: CLAUDE_WORKING, codex: CODEX_WORKING, pi: PI_WORKING }

/**
 * Turn one pane read into a state. Returns null when the pane has no recognisable
 * composer chrome — a plain shell, an alternate-screen app, a pane mid-repaint.
 */
const OVERLAY = /showing detailed transcript|ctrl\+o to toggle|↑\/↓ to scroll/i

/**
 * No composer on screen — an overlay (transcript viewer, model picker) is covering
 * it. herdr answers `unknown` and skips the state update here; we can still do
 * better by reading the last status line, which the overlay does not hide.
 */
function classifyDegraded(lines, kind) {
  const tail = linesAbove(lines, lines.length, 10)
  const patterns = WORKING_PATTERNS[kind] ?? [...CLAUDE_WORKING, ...CODEX_WORKING, ...PI_WORKING]
  const overlay = tail.some(({ text }) => OVERLAY.test(text))
  const note = overlay ? 'overlay open over the composer' : 'no composer chrome on screen'

  const spinner = tail.find(({ text }) => patterns.some((pattern) => pattern.test(text)))
  if (spinner) return { state: 'working', detail: `${note}; spinner still live`, evidence: { spinner: spinner.text } }

  const ended = tail.find(({ text }) => CLAUDE_TURN_ENDED.test(text))
  if (ended) return { state: 'idle', detail: `${note}; ${ended.text.trim()}`, evidence: { turnEnded: ended.text.trim() } }

  return null
}

export function classify(lines, kind) {
  const chrome = locate(lines, kind)
  if (!chrome) return classifyDegraded(lines, kind)

  const { status } = chrome
  const composer = composerContent(chrome.composer)
  const patterns = WORKING_PATTERNS[kind] ?? [...CLAUDE_WORKING, ...CODEX_WORKING, ...PI_WORKING]

  const spinner = status.find(({ text }) => patterns.some((pattern) => pattern.test(text)))
  const ended = status.find(({ text }) => CLAUDE_TURN_ENDED.test(text))

  // An approval UI is drawn inside or just above the composer.
  const blockedScope = [...status, ...chrome.composer]
  const blocked = blockedScope.find(({ text }) => BLOCKED_PATTERNS.some((pattern) => pattern.test(text)))

  if (spinner) {
    return composer.length > 0
      ? {
          state: 'queued-message',
          detail: `working; ${composer.length} unsent line(s) queued behind the current turn`,
          evidence: { spinner: spinner.text, queued: composer.slice(0, 3) },
        }
      : { state: 'working', detail: 'spinner live above the composer', evidence: { spinner: spinner.text } }
  }

  if (blocked) {
    return {
      state: 'input-pending',
      detail: 'approval or question prompt is up; the turn cannot advance without a human',
      evidence: { prompt: blocked.text },
    }
  }

  if (composer.length > 0) {
    const attachment = composer.find((entry) => UNSUBMITTED_ATTACHMENT.test(entry))
    return {
      state: 'input-pending',
      detail: attachment
        ? 'unsubmitted attachment sitting in the composer — never submitted'
        : 'text typed into the composer but not submitted',
      evidence: { composer: composer.slice(0, 3) },
    }
  }

  return {
    state: 'idle',
    detail: ended ? `turn ended — ${ended.text.trim()}` : 'composer empty, no spinner',
    evidence: ended ? { turnEnded: ended.text.trim() } : { composer: '(empty)' },
  }
}

const SETTLED = new Set(['idle', 'input-pending'])

// --- pane resolution -------------------------------------------------------

function resolveTarget(target, agents) {
  const byPane = agents.find((agent) => agent.pane_id === target)
  if (byPane) return byPane
  const lowered = target.toLowerCase()
  const byTitle = agents.filter((agent) => (agent.title || '').toLowerCase() === lowered)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new Error(`"${target}" matches ${byTitle.length} panes: ${byTitle.map((a) => a.pane_id).join(', ')}`)
  }
  return null
}

// --- status ----------------------------------------------------------------

async function statusOf(target, agents, { fast = false, lines = DEFAULT_LINES } = {}) {
  let agent = null
  try {
    agent = resolveTarget(target, agents)
  } catch (error) {
    return { pane: target, title: null, agent: null, state: 'unknown', detail: error.message, evidence: {} }
  }

  const paneId = agent?.pane_id ?? target
  const base = { pane: paneId, title: agent?.title ?? null, agent: agent?.agent ?? null }

  const raw = await readPane(paneId, { source: 'visible', lines, ansi: true })
  if (raw === null) {
    return { ...base, state: 'unknown', detail: `pane ${paneId} not found`, evidence: {} }
  }

  const verdict = classify(parseLines(raw), agent?.agent)
  const explained = fast ? null : await explainAgent(paneId).catch(() => null)

  // Recorded, never trusted. When these disagree, this tool is right (trap 1).
  const herdrView = {
    agent_status: agent?.agent_status ?? null,
    rule: explained?.rule ?? null,
    fallback_reason: explained?.fallback_reason ?? null,
    trustworthy: Boolean(explained?.rule) && explained.rule !== 'none' && !explained.rule.startsWith('live_prompt_box'),
  }

  if (!verdict) {
    return {
      ...base,
      state: 'unknown',
      detail: 'no agent composer chrome on screen (plain shell, alternate screen, or mid-repaint)',
      evidence: { herdr: herdrView },
    }
  }

  return { ...base, ...verdict, evidence: { ...verdict.evidence, herdr: herdrView } }
}

// --- wait ------------------------------------------------------------------

/** Regex handed to `pane wait-output` purely to wake us up early. Never a verdict. */
const WAKEUP_REGEX = {
  claude: '[✻✳✽] \\S+ for ',
  codex: 'tokens used|^› ',
  pi: '─{20,}',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Block until one pane's turn has ended.
 *
 * Fast path: `herdr pane wait-output` parks on the server until the settled
 * marker appears, so a genuinely busy pane costs zero reads for the whole turn.
 * Because that match is contaminable (trap 7) it only ever triggers a structural
 * re-read. Panes with no usable marker — and the caller's own pane — fall back to
 * adaptive polling, which is still bounded and cheap.
 */
async function waitForPane(target, agents, { timeout, settle, lines }) {
  const started = Date.now()
  const deadline = started + timeout
  const agent = resolveTarget(target, agents)
  const paneId = agent?.pane_id ?? target
  const wakeup = agent ? WAKEUP_REGEX[agent.agent] : null
  const pollOnly = !wakeup || paneId === SELF_PANE

  let backoff = 400
  let confirmedAt = null

  while (Date.now() < deadline) {
    const snapshot = await statusOf(target, agents, { fast: true, lines })

    if (SETTLED.has(snapshot.state)) {
      // Require the state to hold across `settle` ms: the gap between the spinner
      // stopping and the summary line rendering can read as idle for one frame.
      if (confirmedAt === null) {
        confirmedAt = Date.now()
        await sleep(settle)
        continue
      }
      return { ...snapshot, settledMs: Date.now() - started, timedOut: false }
    }
    confirmedAt = null

    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    if (pollOnly) {
      await sleep(Math.min(backoff, remaining))
      backoff = Math.min(backoff * 1.5, 2000)
      continue
    }

    const budget = Math.min(remaining, 15_000)
    const woke = Date.now()
    await herdr(
      ['pane', 'wait-output', paneId, '--regex', wakeup, '--source', 'visible', '--lines', String(lines), '--timeout', String(budget)],
      { timeout: budget + 5000 },
    ).catch(() => null)
    // A match on text that was already there returns immediately; don't spin.
    if (Date.now() - woke < 250) await sleep(Math.min(1000, deadline - Date.now()))
  }

  const final = await statusOf(target, agents, { fast: true, lines })
  return { ...final, settledMs: Date.now() - started, timedOut: !SETTLED.has(final.state) }
}

// --- cli -------------------------------------------------------------------

function parseArgs(argv) {
  const targets = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      targets.push(token)
      continue
    }
    const key = token.slice(2)
    if (['timeout', 'settle', 'lines'].includes(key)) {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} needs a non-negative number`)
      flags[key] = value
      index += 1
    } else {
      flags[key] = true
    }
  }
  return { targets, flags }
}

const STATE_COLUMN = {
  working: 'WORKING',
  'queued-message': 'QUEUED',
  'input-pending': 'INPUT',
  idle: 'idle',
  unknown: '?',
}

function renderTable(rows, { showSettle = false } = {}) {
  const width = (pick) => Math.max(...rows.map((row) => String(pick(row) ?? '').length), 1)
  const nameWidth = width((row) => row.title || row.pane)
  const paneWidth = width((row) => row.pane)
  return rows
    .map((row) => {
      const name = String(row.title || row.pane).padEnd(nameWidth)
      const pane = String(row.pane).padEnd(paneWidth)
      const state = STATE_COLUMN[row.state].padEnd(8)
      const timing = showSettle ? `${String(`${(row.settledMs / 1000).toFixed(1)}s`).padStart(7)}  ` : ''
      const flag = row.timedOut ? ' [TIMEOUT]' : ''
      return `${name}  ${pane}  ${state}  ${timing}${row.detail}${flag}`
    })
    .join('\n')
}

const USAGE = `orch-status — turn-state for orchestrated agent panes

  status <pane|title...> [--table] [--fast] [--lines N]
  wait   <pane|title...> [--timeout ms] [--settle ms] [--table] [--lines N]

  --table      human-readable rows instead of JSON
  --fast       skip the per-pane \`herdr agent explain\` call
  --timeout    total wait budget per pane, default 900000 (15m)
  --settle     hold-down before declaring a turn ended, default 800
  --lines      pane rows to read, default ${DEFAULT_LINES}
`

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    process.stdout.write(USAGE)
    return 0
  }

  const { targets, flags } = parseArgs(rest)
  if (targets.length === 0) {
    process.stderr.write(`${USAGE}\nerror: no panes given\n`)
    return 2
  }

  const agents = await listAgents()
  const lines = flags.lines ?? DEFAULT_LINES

  if (command === 'status') {
    const rows = await mapLimit(targets, 8, (target) => statusOf(target, agents, { fast: Boolean(flags.fast), lines }))
    process.stdout.write(flags.table ? `${renderTable(rows)}\n` : `${JSON.stringify(rows, null, 2)}\n`)
    return rows.some((row) => row.state === 'unknown') ? 1 : 0
  }

  if (command === 'wait') {
    const options = { timeout: flags.timeout ?? 900_000, settle: flags.settle ?? 800, lines }
    const rows = await Promise.all(targets.map((target) => waitForPane(target, agents, options)))
    process.stdout.write(flags.table ? `${renderTable(rows, { showSettle: true })}\n` : `${JSON.stringify(rows, null, 2)}\n`)
    return rows.some((row) => row.timedOut) ? 1 : 0
  }

  process.stderr.write(`${USAGE}\nerror: unknown command "${command}"\n`)
  return 2
}

// Only run as a CLI; the self-test imports classify()/parseLines() from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`orch-status: ${error.message}\n`)
      process.exit(2)
    })
}
