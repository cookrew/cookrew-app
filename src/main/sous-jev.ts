// THE FIVE-QUESTION JEV DECISION (E2E round, lane jev, design v3.1 §3–§4),
// behind COOKREW_SOUS_JEV=1 and OFF by default: with the flag off nothing in
// this file runs and decide()'s output is byte-identical to today.
//
// One POST to Magpie's /v1/systemone asks five questions of a decision
// model in parallel — path (a Choice over the ALLOWED set, labels never ids,
// plus an escape), harness (a Choice on task shape), human (Noul), question
// (Noul), exposure (Score 0–3), domain (Choice) — and the answers may only
// REFINE the rule-based draft: path inside the allowed set, exposure raised
// never lowered, a Noul override only above its threshold. The call has a
// soft deadline and rides the Sous breaker; any timeout, 4xx, open breaker or
// malformed body leaves the draft as it was, badged 'rule (timed out)'.
//
// Wire facts (report-hp-facts §1, recorded from magpie's own Go source):
// `questions` is a map keyed by name; a choice's `criteria` is option →
// description; a score's `criteria` is an array; there is NO `rubric` field —
// the `instructions` string carries the ask; answers come back per question
// as {choice, score, confidence, noul}; `confidence` is derived from
// per-option probabilities when the provider gives none.

import { randomUUID } from 'node:crypto'
import { words, titleOf, type Alternate, type DecideCandidate, type DecisionDraft, type Harness, type RoutingFacts } from '../shared/sous-decide'
import { questionBack } from '../shared/sous-decide'
import type { Exposure } from '../shared/sous-exposure'
import type { SousBreaker } from './sous-breaker'

export const JEV_FLAG = 'COOKREW_SOUS_JEV'
export const JEV_MODEL = 'group/jevs'
export const JEV_DEADLINE_MS = 800
export const T_CHOICE = 0.85
export const T_NOUL = 0.7
export const MARGIN_TO_TICK = 0.15
export const MAX_CANDIDATES = 8
export const ESCAPE = 'none of these — ask the owner'
export const BADGE_TIMED_OUT = 'rule (timed out)'
export const BADGE_JEV = 'jev'

export function jevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_FLAG] === '1'
}

// ── the request ──────────────────────────────────────────────────────────

export interface JevInput {
  sentence: string
  lang: 'zh' | 'en'
  repo: string | null
  /** The allowed set, as decide() sees it: same repo, idle, not full, not served. */
  candidates: readonly DecideCandidate[]
  routing?: RoutingFacts
  /** The last three Sous decisions, one line each. */
  recent: readonly string[]
  now: number
  token: string
}

export interface JevRequest {
  body: Record<string, unknown>
  /** Option label → candidate id (the model never sees an id). */
  labels: Map<string, string>
  /** Harness option label → harness. */
  harnessLabels: Map<string, Harness>
  /** Candidate id → what the echo says if Jev picks it. */
  cards: Map<string, { name: string; reasons: string[] }>
}

const HARNESS_SHAPES: Record<string, Harness | null> = {
  'quick/small/explain': 'Pi',
  'repo-wide refactor/review': 'Codex',
  'tests/feature/multi-step': 'Claude Code',
  unclear: null
}

function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

const overlap = (a: Set<string>, b: Set<string>): number => [...a].filter((w) => b.has(w)).length

/** The allowed set, pre-ranked by content overlap and cut to MAX_CANDIDATES when larger. */
export function allowedSet(sentence: string, candidates: readonly DecideCandidate[], workdir: string | null): DecideCandidate[] {
  const said = words(sentence)
  const idle = new Set(['done', 'unread', 'waiting'])
  const allowed = candidates.filter((c) => !c.served && !c.contextFull && idle.has(c.phase) && workdir !== null && c.cwd === workdir)
  if (allowed.length <= MAX_CANDIDATES) return allowed
  return [...allowed]
    .map((c) => ({ c, score: overlap(words(`${c.role ?? ''} ${c.lastTask ?? ''}`), said) }))
    .sort((a, b) => b.score - a.score || b.c.lastActivityAt - a.c.lastActivityAt)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.c)
}

export function buildJevRequest(input: JevInput): JevRequest {
  const labels = new Map<string, string>()
  const cards = new Map<string, { name: string; reasons: string[] }>()
  const criteria: Record<string, string | null> = {}
  for (const c of input.candidates) {
    const label = `${c.name} · ${c.role ?? '—'} · idle ${ago(c.lastActivityAt, input.now)} · last: ${c.lastTask ?? '—'}`
    labels.set(label, c.id)
    cards.set(c.id, { name: c.name, reasons: [c.phase === 'waiting' ? 'waiting' : 'idle', 'same repo', c.role ? `role: ${c.role}` : `last: ${c.lastTask ?? '—'}`] })
    criteria[label] = `An existing card: ${c.role ? `role ${c.role}, ` : ''}last task "${c.lastTask ?? 'none'}", idle for ${ago(c.lastActivityAt, input.now)}.`
  }
  const harnessLabels = new Map<string, Harness>()
  const newCards: Array<[string, Harness]> = [
    ['new claude card', 'Claude Code'],
    ['new codex card', 'Codex'],
    ['new pi card', 'Pi']
  ]
  for (const [label, harness] of newCards) {
    if (input.routing?.defaultSet && input.routing.routable[harness] === false) continue
    harnessLabels.set(label, harness)
    criteria[label] = `A new ${harness} card for this sentence, beside the orchestrator.`
  }
  criteria[ESCAPE] = 'No listed card fits and no new card should be made: ask the owner.'
  const body = {
    model: JEV_MODEL,
    state: {
      sentence: input.sentence,
      lang: input.lang,
      repo: input.repo ?? '',
      candidates: input.candidates.map((c) => `${c.name} · ${c.role ?? '—'} · last: ${c.lastTask ?? '—'}`).join('\n'),
      recent: input.recent.join('\n')
    },
    questions: {
      path: { type: 'choice', instructions: "Pick who should take this sentence; 'none of these' when no listed card fits and no new card should be made.", criteria },
      harness: {
        type: 'choice',
        instructions: 'What SHAPE of task is this sentence — not which product.',
        criteria: {
          'quick/small/explain': 'A small, quick or explanatory task a light local model can do.',
          'repo-wide refactor/review': 'A change or review across many files of one repository.',
          'tests/feature/multi-step': 'A feature, a test suite or a multi-step change with verification.',
          unclear: 'The shape cannot be told from the sentence.'
        }
      },
      human: { type: 'noul', instructions: 'The owner must decide or answer this themselves; no agent should take it.' },
      question: { type: 'noul', instructions: 'This is a question to Sous or small talk, not a task for an agent.' },
      exposure: {
        type: 'score',
        instructions: 'How much can go wrong if this is done by the wrong card or done badly, 0 to 3.',
        criteria: ['read-only or trivially reversible', 'a code change that can be rolled back', 'delete, push, release, spend money or change configuration', 'touches secrets, accounts, another person\'s card or a served session']
      },
      domain: {
        type: 'choice',
        instructions: 'Where does this sentence live?',
        criteria: { repo: 'Work on the code in this repository.', chore: 'A task outside the repository (an errand, a document, a booking).', question: 'A question or remark, not a task.' }
      }
    }
  }
  return { body, labels, harnessLabels, cards }
}

// ── the answers ──────────────────────────────────────────────────────────

export interface JevAnswer {
  choice?: string
  score?: number
  noul?: number
  confidence: number
  /** top-1 − top-2 of the provider's probabilities; absent when it gave none. */
  margin?: number
}

export type JevAnswers = Partial<Record<'path' | 'harness' | 'human' | 'question' | 'exposure' | 'domain', JevAnswer>>

/** magpie's own derivation (decide_wire.go:85-99): 0 when every option is equally likely, 1 when one is certain. */
export function confidenceOf(probabilities: readonly number[]): number {
  const n = probabilities.length
  if (n === 0) return 0
  if (n === 1) return 1
  const top = Math.max(...probabilities)
  return Math.max(0, (top - 1 / n) / (1 - 1 / n))
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function parseJevAnswers(body: unknown): JevAnswers {
  if (!body || typeof body !== 'object') throw new Error('malformed System One body: not an object')
  const answers = (body as { answers?: unknown }).answers
  if (!answers || typeof answers !== 'object') throw new Error('malformed System One body: no answers')
  const out: JevAnswers = {}
  for (const [name, raw] of Object.entries(answers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') throw new Error(`malformed System One answer: ${name}`)
    const a = raw as Record<string, unknown>
    const probs = a.probabilities
    const list = Array.isArray(probs) ? probs.filter((p): p is number => typeof p === 'number') : probs && typeof probs === 'object' ? Object.values(probs as Record<string, unknown>).filter((p): p is number => typeof p === 'number') : null
    const confidence = asNumber(a.confidence) ?? (list ? confidenceOf(list) : undefined)
    if (confidence === undefined) throw new Error(`malformed System One answer: ${name} has no confidence`)
    const parsed: JevAnswer = { confidence: Math.max(0, Math.min(1, confidence)) }
    if (list && list.length >= 2) {
      const sorted = [...list].sort((x, y) => y - x)
      parsed.margin = sorted[0] - sorted[1]
    } else if (list && list.length === 1) parsed.margin = 1
    if (typeof a.choice === 'string') parsed.choice = a.choice
    const score = asNumber(a.score)
    if (score !== undefined) parsed.score = score
    const noul = asNumber(a.noul)
    if (noul !== undefined) parsed.noul = noul
    ;(out as Record<string, JevAnswer>)[name] = parsed
  }
  return out
}

// ── the merge ────────────────────────────────────────────────────────────

export interface JevMerge {
  draft: DecisionDraft
  /** What the box prints beside the line. */
  badge: string
  /** The hold the merge asks for; null = the code's own rule. */
  mode: 'paused' | 'ticking' | null
  reasons: string[]
}

/**
 * The merge contract (§4): Noul first (human ≥ T_NOUL or the escape or a Jev
 * exposure of 3 → ask back; question ≥ T_NOUL → ask back as a question); path
 * may only re-pick INSIDE the allowed set and only at T_CHOICE, and it ticks
 * only with a margin; harness only on a recruit; exposure only ever RAISED.
 */
export function mergeJev(draft0: DecisionDraft, answers: JevAnswers, request: JevRequest, routing: RoutingFacts | undefined, sentence: string): JevMerge {
  const reasons: string[] = []
  const codeExposure = (draft0.exposure ?? 0) as Exposure
  const jevExposure = answers.exposure?.score !== undefined ? (Math.max(0, Math.min(3, Math.round(answers.exposure.score))) as Exposure) : codeExposure
  const exposure = (jevExposure > codeExposure ? jevExposure : codeExposure) as Exposure
  const raised = exposure > codeExposure
  if (raised) reasons.push(`exposure raised to ${exposure} by jev`)
  const facts = { exposure, ...(raised ? { exposureWhy: `jev: ${answers.exposure?.score}` } : {}) }

  const human = answers.human?.noul ?? 0
  const questionP = answers.question?.noul ?? 0
  const pathChoice = answers.path?.choice
  const escaped = pathChoice === ESCAPE && (answers.path?.confidence ?? 0) >= T_CHOICE
  if (human >= T_NOUL || escaped || exposure === 3) {
    const why = human >= T_NOUL ? `human ${human.toFixed(2)}` : escaped ? 'none of these' : 'exposure 3'
    return {
      draft: { kind: 'question', question: questionBack(sentence), answer: null, reasons: [`jev: ${why}`, 'ask the owner', 'nothing is created'], domain: 'question', mode: 'question', exposure, exposureWhy: facts.exposureWhy ?? draft0.exposureWhy ?? null, boundaries: null, route: null },
      badge: BADGE_JEV,
      mode: null,
      reasons: [...reasons, why]
    }
  }
  if (questionP >= T_NOUL && draft0.kind !== 'question') {
    return {
      draft: { kind: 'question', question: questionBack(sentence), answer: null, reasons: [`jev: question ${questionP.toFixed(2)}`, 'nothing is created', 'answer in the box'], domain: 'question', mode: 'question', exposure: 0, exposureWhy: null, boundaries: null, route: null },
      badge: BADGE_JEV,
      mode: null,
      reasons: [...reasons, `question ${questionP.toFixed(2)}`]
    }
  }
  if (draft0.kind === 'question') return { draft: draft0, badge: BADGE_JEV, mode: null, reasons }

  let draft: DecisionDraft = { ...draft0, ...facts } as DecisionDraft
  let mode: 'paused' | 'ticking' | null = null
  const pathConf = answers.path?.confidence ?? 0
  if (pathChoice !== undefined && pathConf >= T_CHOICE) {
    const cardId = request.labels.get(pathChoice)
    const harness = request.harnessLabels.get(pathChoice)
    const picked = cardId !== undefined ? request.cards.get(cardId) : undefined
    if (cardId !== undefined && picked && draft.kind === 'ask' && draft.target.id !== cardId) {
      // Inside the allowed set (the request's own labels), never outside it.
      const demoted: Alternate = { kind: 'ask', id: draft.target.id, name: draft.target.name, reasons: draft.reasons }
      draft = { ...draft, target: { id: cardId, name: picked.name }, alternates: [demoted, ...draft.alternates.filter((a) => a.id !== cardId)], reasons: [...picked.reasons.slice(0, 2), `jev ${pathConf.toFixed(2)}`] }
      reasons.push(`path → ${picked.name}`)
    } else if (cardId !== undefined && picked && draft.kind === 'recruit' && draft0.kind === 'recruit') {
      draft = { ...draft0, ...facts, kind: 'ask', target: { id: cardId, name: picked.name }, alternates: [{ kind: 'recruit', id: `harness:${draft0.harness}`, name: draft0.harness, harness: draft0.harness, reasons: draft0.reasons.slice(1, 2) }], reasons: [...picked.reasons.slice(0, 2), `jev ${pathConf.toFixed(2)}`], recruit: { harness: draft0.harness, name: draft0.name, beside: draft0.beside, direct: draft0.direct } } as DecisionDraft
      reasons.push(`path → ${picked.name}`)
    } else if (harness !== undefined && draft.kind === 'ask' && draft0.kind === 'ask') {
      const recruitAlt = draft.alternates.find((a) => a.kind === 'recruit')
      if (recruitAlt) {
        draft = { ...draft0, ...facts, kind: 'recruit', harness, name: draft0.recruit.name, beside: draft0.recruit.beside, direct: draft0.recruit.direct, cwd: 'repo', alternates: [{ kind: 'ask', id: draft0.target.id, name: draft0.target.name, reasons: draft0.reasons }], reasons: ['no listed card fits', `${harness} (jev ${pathConf.toFixed(2)})`, draft0.recruit.beside ? `beside ${draft0.recruit.beside.name}, wired to it` : 'placed on the bench'] } as DecisionDraft
        reasons.push(`path → new ${harness} card`)
      }
    }
    // A confident pick ticks only with a top-2 margin; a provider that gave
    // no probabilities gives no margin, and the owner is asked to look.
    const margin = answers.path?.margin
    mode = margin !== undefined && margin >= MARGIN_TO_TICK ? 'ticking' : 'paused'
    if (mode === 'paused') reasons.push(margin === undefined ? 'margin unknown' : 'margin narrow')
  } else if (pathChoice !== undefined) {
    mode = 'paused'
    reasons.push(`path ${pathConf.toFixed(2)} < ${T_CHOICE}`)
  }

  if (draft.kind === 'recruit' && answers.harness?.choice !== undefined && (answers.harness.confidence ?? 0) >= T_CHOICE) {
    const shaped = HARNESS_SHAPES[answers.harness.choice] ?? null
    if (shaped !== null) {
      const routable = !(routing?.defaultSet && routing.routable[shaped] === false)
      const harness: Harness = routable ? shaped : 'Claude Code'
      if (harness !== draft.harness) {
        draft = { ...draft, harness, reasons: [draft.reasons[0], routable ? `${answers.harness.choice} → ${harness} (jev)` : `${shaped} is not routable → Claude Code (jev)`, draft.reasons[2]] }
        reasons.push(`harness → ${harness}`)
      }
    }
  }
  if (exposure >= 2) mode = 'paused'
  return { draft: { ...draft, exposure } as DecisionDraft, badge: BADGE_JEV, mode, reasons }
}

// ── the call ─────────────────────────────────────────────────────────────

export interface JevDeps {
  gateway: () => { v1: string } | null
  key: () => string
  breaker: SousBreaker
  fetch?: typeof fetch
  now?: () => number
  deadlineMs?: number
}

export type JevResult = { ok: true; answers: JevAnswers; ms: number } | { ok: false; reason: string; ms: number }

/** One budgeted call; never throws. A 4xx/404 (no Jev provider) is a reason, not an exception. */
export async function askJev(request: JevRequest, token: string, deps: JevDeps): Promise<JevResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const gateway = deps.gateway()
  if (!gateway) return { ok: false, reason: 'no gateway', ms: 0 }
  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.deadlineMs ?? JEV_DEADLINE_MS)
  let failure: string | null = null
  try {
    const answers = await deps.breaker.guard(async () => {
      try {
        const res = await doFetch(`${gateway.v1}/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.key()}`, 'x-magpie-session': `sous:decide:${token}` },
          body: JSON.stringify(request.body),
          signal: controller.signal
        })
        const text = await res.text()
        if (!res.ok) {
          let message = `HTTP ${res.status}`
          try {
            const err = JSON.parse(text) as { error?: { message?: string } }
            if (err.error?.message) message = `${res.status}: ${err.error.message}`
          } catch {
            // the status alone is the reason
          }
          failure = message
          return { ok: false as const, reason: message }
        }
        return { ok: true as const, value: parseJevAnswers(JSON.parse(text)) }
      } catch (error) {
        const what = error instanceof Error ? (error.name === 'AbortError' ? 'timed out' : error.message) : String(error)
        failure = what
        return { ok: false as const, reason: what }
      }
    })
    if (answers === null) return { ok: false, reason: failure ?? (deps.breaker.readiness() === 'open' ? 'breaker open' : 'refused'), ms: now() - started }
    return { ok: true, answers, ms: now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The controller's dep: rule draft in, refined draft + badge + hold out.
 * Never throws; a question draft from the rules is left alone (nothing to
 * refine); a miss of any kind is the draft with the timed-out badge.
 */
export function createJevDecider(deps: JevDeps & { recent?: () => readonly string[] }): (input: {
  sentence: string
  lang: 'zh' | 'en'
  draft: DecisionDraft
  candidates: readonly DecideCandidate[]
  workdir: string | null
  routing?: RoutingFacts
  token: string
  now: number
}) => Promise<{ draft: DecisionDraft; badge: string; mode: 'paused' | 'ticking' | null }> {
  return async (input) => {
    try {
      const allowed = allowedSet(input.sentence, input.candidates, input.workdir)
      const request = buildJevRequest({ sentence: input.sentence, lang: input.lang, repo: input.workdir?.split('/').filter(Boolean).at(-1) ?? null, candidates: allowed, routing: input.routing, recent: deps.recent?.() ?? [], now: input.now, token: input.token })
      const result = await askJev(request, input.token, deps)
      if (!result.ok) return { draft: input.draft, badge: BADGE_TIMED_OUT, mode: null }
      const merged = mergeJev(input.draft, result.answers, request, input.routing, input.sentence)
      return { draft: merged.draft, badge: merged.badge, mode: merged.mode }
    } catch {
      return { draft: input.draft, badge: BADGE_TIMED_OUT, mode: null }
    }
  }
}

/** The one line the ledger keeps about a decision, for the next sentence's `recent`. */
export function recentLine(sentence: string, draft: DecisionDraft, agoMs: number): string {
  const who = draft.kind === 'ask' ? `ask ${draft.target.name}` : draft.kind === 'recruit' ? `new ${draft.harness} card` : 'question'
  return `${Math.round(agoMs / 60_000)}m ago: ${titleOf(sentence)} → ${who}`
}

export const newToken = (): string => randomUUID()
