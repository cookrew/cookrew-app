#!/usr/bin/env node
// THE LOCAL TIER OF group/auto, PRINTED — NEVER RUN (route program, E2E round,
// design §5; owner decisions a and b stay the owner's).
//
//   node scripts/route-auto-group.mjs            # reads /v1/models from the gateway, prints the magpie lines
//   MAGPIE_ADDR=:4100 node scripts/route-auto-group.mjs
//
// What it decides: which of the Ollama models the gateway serves can be
// members of a routing group that agents ask for reasoning on. Codex always
// asks for reasoning on the Responses path and a model that refuses it
// answers 400 ("qwen2.5:1.5b does not support thinking" — report-hp-facts.md,
// route program rounds 2–3), while the catalog's `reasoning` flag reads
// false for EVERY Ollama model, thinkers included. So the pick is by model
// family, said out loud per model, and the owner reads the list before
// running a line.
//
// What it prints: the `magpie group add auto …` line with routing=smart and
// stays=turn. stays=turn is REQUIRED: stays=session pins per BEARER and leaks
// one card's pin into every other card on the same key (facts §4). It
// prints the line; it does not run it, and it mints nothing.
//
// The picker is exported so tests/route-auto-group.test.ts can run it on a
// recorded /v1/models body.

const DEFAULT_PORT = 3425
const KEY = process.env.COOKREW_ROUTE_APP_KEY ?? 'magpie-cookrew'

/** Ollama families known to take a reasoning ask (verified: qwen3 on the real gateway). */
const THINKERS = [/^qwen3\b/, /^deepseek-r1\b/, /^gpt-oss\b/, /^magistral\b/, /^qwq\b/, /^phi4-reasoning\b/, /^glm-?4\.?5\b/]
/** Families seen to refuse one with a 400 (qwen2.5 on the real gateway), or known not to think. */
const REFUSERS = [/^qwen2(\.5)?\b/, /^llama\d/, /^gemma\d?\b/, /^mistral\b/, /^codellama\b/, /^phi[0-3]\b/]

export function classify(ollamaId) {
  const bare = ollamaId.replace(/^ollama\//, '')
  if (THINKERS.some((re) => re.test(bare))) return { ok: true, why: 'takes a reasoning ask' }
  if (REFUSERS.some((re) => re.test(bare))) return { ok: false, why: 'refuses a reasoning ask (400 "does not support thinking")' }
  return { ok: false, why: 'unknown family — not assumed to think; add it by hand if it does' }
}

/**
 * The plan for group `auto` from a /v1/models body: the Ollama members that
 * take reasoning, the ones left out with the reason, and the lines to type.
 */
export function autoGroupPlan(catalog) {
  const rows = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.data) ? catalog.data : []
  const ollama = rows.map((r) => (typeof r?.id === 'string' ? r.id : null)).filter((id) => id !== null && id.startsWith('ollama/'))
  const members = []
  const excluded = []
  for (const id of ollama) {
    const verdict = classify(id)
    if (verdict.ok) members.push(id)
    else excluded.push({ id, why: verdict.why })
  }
  const exists = rows.some((r) => r?.id === 'group/auto')
  const commands = members.length > 0 ? [`magpie group ${exists ? 'set' : 'add'} auto models=${members.join(',')} routing=smart stays=turn`] : []
  return { members, excluded, exists, commands }
}

export function render(plan) {
  const lines = []
  lines.push(`# group/auto — local tier (Ollama models that take a reasoning ask), routing=smart stays=turn`)
  for (const id of plan.members) lines.push(`#   + ${id}`)
  for (const row of plan.excluded) lines.push(`#   - ${row.id}: ${row.why}`)
  if (plan.commands.length === 0) {
    lines.push(`# nothing to add: no Ollama model the gateway serves is known to take a reasoning ask`)
    return lines.join('\n')
  }
  lines.push(`# ${plan.exists ? 'group/auto exists: the line REPLACES its members' : 'group/auto does not exist yet'} — printed, not run; copy it into the Setup card:`)
  lines.push(...plan.commands)
  return lines.join('\n')
}

function gatewayUrl() {
  const addr = process.env.MAGPIE_ADDR
  if (!addr) return `http://127.0.0.1:${DEFAULT_PORT}`
  if (/^https?:\/\//.test(addr)) return addr.replace(/\/+$/, '')
  return `http://${addr.startsWith(':') ? `127.0.0.1${addr}` : addr}`
}

async function main() {
  const url = gatewayUrl()
  let body
  try {
    const res = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${KEY}`, 'user-agent': 'cookrew' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = await res.json()
  } catch (error) {
    process.stderr.write(`route-auto-group: the gateway at ${url} did not answer /v1/models (${String(error)}); is magpie running?\n`)
    process.exit(2)
  }
  process.stdout.write(`${render(autoGroupPlan(body))}\n`)
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) await main()
