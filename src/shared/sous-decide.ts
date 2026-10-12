// SOUS DECIDES WHO — the step after the regex intent core comes up empty
// (route program R3, design section 4). A sentence that is not a command the
// parser knows is one of three things: a task for a card that already exists,
// a task that wants a new card, or a question for a person. Every answer
// names its reasons — three for a pick, or the question back — never a guess.
//
// Pure: the candidates, the workdir and the clock come in; a draft decision
// comes out. Main stamps it with a token and executes on commit
// (sous-control.ts), so the box can show the decision for a beat and let the
// owner change it. Deterministic by design — the optional Jev scorer (Magpie's
// systemone) is a refinement main may add behind a flag, not a dependency.

import type { BoardPhase } from './board'
import { contentWords, hasGenericVerb, isRepoTask, saidWords, STOP_WORDS } from './sous-words'
import { boundaries, exposure, type Exposure } from './sous-exposure'

export type Harness = 'Claude Code' | 'Codex' | 'OpenCode' | 'Pi'

export interface DecideCandidate {
  id: string
  name: string
  workspaceId: string
  /** The directory the card works in — "same repo" is equality with the workdir. */
  cwd: string
  role: string | null
  orch: boolean
  phase: BoardPhase
  /** The pre-dispatch probe's verdict: a full context cannot take a brief. */
  contextFull: boolean
  /** The card's last task, as the Board summarises it — what it "last touched". */
  lastTask: string | null
  lastActivityAt: number
  /** Somebody else's seat at this machine: never a target, never a digest row a brief goes to. */
  served?: boolean
}

/** What a status question is answered from, beyond the candidates. */
export interface StatusFacts {
  openDispatches: number
}

export interface DecideContext {
  candidates: readonly DecideCandidate[]
  /** The active workspace's directory. */
  workdir: string | null
  now: number
  /** Absent = no route service: today's shape rules, every harness runs direct. */
  routing?: RoutingFacts
  status?: StatusFacts
}

/** Where a sentence lives: in the repo, in a chore card outside it, or in an answer. */
export type Domain = 'repo' | 'chore' | 'question'

/** What every draft carries (HP contract): the domain and the exposure tier with its one boundary line. */
export interface DraftFacts {
  domain: Domain
  exposure: Exposure
  exposureWhy: string | null
  boundaries: string | null
}

/** Another way to go: a card (`ask`, id = the card) or a new card (`recruit`, id = `harness:<name>`). The echo always offers the other path. */
export interface Alternate {
  kind: 'ask' | 'recruit'
  id: string
  name: string
  reasons: string[]
  harness?: Harness
}

/** What a recruit would be, carried on an ask so the alternate can be committed without re-deciding. */
export interface RecruitPath {
  harness: Harness
  name: string
  beside: { id: string; name: string } | null
  /** The harness will run direct — no default route, or the harness cannot be routed. */
  direct: boolean
}

export type DecisionDraft =
  | ({ kind: 'ask'; target: { id: string; name: string }; alternates: Alternate[]; reasons: string[]; recruit: RecruitPath } & DraftFacts)
  | ({
      kind: 'recruit'
      harness: Harness
      /** The new card's name — the sentence, shortened to a title. */
      name: string
      /** The orch the card is placed beside and wired to, when the workdir has one. */
      beside: { id: string; name: string } | null
      alternates: Alternate[]
      reasons: string[]
      /** The chosen harness will run direct (no default route set, or it is not routable). */
      direct: boolean
      /** Where the card works: the repo, or the chores directory outside it. */
      cwd: 'repo' | 'chores'
    } & DraftFacts)
  | ({
      kind: 'question'
      question: string
      reasons: string[]
      /** `question` asks back; `answer` is answered from the digest, deterministically. */
      mode: 'question' | 'answer'
      answer: string | null
    } & DraftFacts)

/** How long the box holds the echo before committing on its own. */
export const DECISION_HOLD_MS = 2500
/** How long main keeps an uncommitted decision before it expires. */
export const DECISION_TTL_MS = 30_000

// ── words ─────────────────────────────────────────────────────────────────

/** Content words: stopwords and generic task verbs never count (shared/sous-words.ts). */
export const words = contentWords

/** Routability, as the route service knows it: is a fleet default set, and which harnesses can be pointed at the gateway. */
export interface RoutingFacts {
  defaultSet: boolean
  routable: Partial<Record<Harness, boolean>>
}

const overlap = (a: Set<string>, b: Set<string>): string[] => [...a].filter((w) => b.has(w))

// ── question or task ──────────────────────────────────────────────────────

const QUESTION_RE =
  /\?|？|^(?:when|should|shall|could|would|can we|what|why|who|how about|is it|are we|do we|did)\b|^(?:什么时候|要不要|是否|能不能|可以吗|可不可以|怎么|为什么|谁|哪天|几点)|(?:吗|呢|么)$/iu
/** A plan said out loud, not a task: "release next week", "下周发版". */
const PLAN_RE = /(?:^|\s)(?:next week|tomorrow|next month|later|下周|明天|下个月|晚点|改天)/iu
const TASK_VERB_RE =
  /\b(?:make|add|fix|write|delete|remove|refactor|review|test|run|build|rename|move|update|change|implement|check|translate|convert|clean|prune|migrate|document|deploy|release|ship|land|merge)\b|(?:改|加|修|写|删|重构|评审|测|跑|建|更新|实现|检查|翻译|清理|迁移|部署|发布|合并|做)/iu

export function isQuestion(sentence: string): boolean {
  const s = sentence.trim()
  if (QUESTION_RE.test(s)) return true
  // A date and a verb with nothing to act on ("release next week") is a plan
  // said out loud; a brief that happens to mention a date has an object too.
  if (PLAN_RE.test(s) && saidWords(s).size <= 3) return true
  // Two words with no verb anyone could act on is a remark, not a brief.
  // Counted with the verbs in: "compose a sonnet" is a brief, not a remark.
  return saidWords(s).size <= 2 && !TASK_VERB_RE.test(s) && !hasGenericVerb(s)
}

/** What Sous asks back — it names the sentence, so the owner sees what was heard. */
export function questionBack(sentence: string): string {
  const s = sentence.trim().replace(/[?？。.!！]+$/u, '')
  return /[一-鿿]/.test(s) ? `「${s}」——这是要我做的事，还是问我的问题？说清楚派给谁，或者直接告诉我做什么。` : `“${s}” — is that a task for the crew, or a question for me? Name who, or say what to do.`
}

/** A question about the BOARD — answered from it, no model: who waits, what runs, what is out. */
const STATUS_RE = /\b(?:status|progress|who(?:'s| is) (?:waiting|blocked|working|busy|idle)|what(?:'s| is) (?:blocked|running|waiting|the status)|where are we|how far|can we (?:ship|release|deploy)|ready to (?:ship|release)|any(?:one|thing) (?:waiting|blocked))\b|(?:进度|状态|谁在等|谁卡住|卡住了吗|能不能发|可以发版|发版了吗|能发版|在跑什么|谁在干活|在等我)/iu

export function isStatusQuestion(sentence: string): boolean {
  return STATUS_RE.test(sentence.trim())
}

function agoWords(at: number, now: number): string {
  return ago(at, now)
}

/** The deterministic answer: waiting cards by name and how long, what is running, open dispatches. */
export function statusAnswer(ctx: DecideContext): string {
  const zh = false
  const now = ctx.now
  const crew = ctx.candidates.filter((c) => !c.served)
  const waiting = crew.filter((c) => c.phase === 'waiting').sort((a, b) => a.lastActivityAt - b.lastActivityAt)
  const working = crew.filter((c) => c.phase === 'working')
  const full = crew.filter((c) => c.contextFull)
  const parts: string[] = []
  parts.push(waiting.length === 0 ? 'nobody is waiting on you' : `waiting on you: ${waiting.map((c) => `${c.name} (${agoWords(c.lastActivityAt, now)})`).join(', ')}`)
  parts.push(working.length === 0 ? 'nothing is running' : `running: ${working.map((c) => c.name).join(', ')}`)
  if (ctx.status && ctx.status.openDispatches > 0) parts.push(`${ctx.status.openDispatches} dispatch${ctx.status.openDispatches === 1 ? '' : 'es'} open`)
  if (full.length > 0) parts.push(`context full: ${full.map((c) => c.name).join(', ')}`)
  void zh
  return `${parts.join(' · ')}.`
}

// ── harness by task shape ─────────────────────────────────────────────────

const LONG_RE = /\b(?:tests?|spec|ci|e2e|end.to.end|multi.?step|pipeline|feature|implement|build|migrate|across|several|many files)\b|(?:测试|多步|功能|实现|迁移|流水线|端到端|多个文件)/iu
const REPO_RE = /\b(?:repo-?wide|whole repo|every|all|refactor|review|audit|rename across|prune|delete every|clean ?up|lint|dead code)\b|(?:全仓|整个仓库|所有|全部|重构|评审|审计|清理|死代码)/iu
const LIGHT_RE = /\b(?:quick|small|tiny|cheap|local|offline|explain|summari[sz]e|what does|look up|draft|one.?liner|typo)\b|(?:快速|小改|便宜|本地|离线|解释|总结|看看|草稿|错别字)/iu

export function pickHarness(sentence: string, routing?: RoutingFacts): { harness: Harness; reason: string; direct: boolean } {
  const shaped = shapeHarness(sentence)
  if (!routing?.defaultSet) return { ...shaped, direct: true }
  // A default route is set: a harness that cannot be routed would silently
  // run direct — pick Claude Code instead and say why.
  if (routing.routable[shaped.harness] === false) {
    return { harness: 'Claude Code', reason: `${shaped.harness} is not routable → Claude Code on the default route`, direct: false }
  }
  return { ...shaped, direct: false }
}

function shapeHarness(sentence: string): { harness: Harness; reason: string } {
  if (LIGHT_RE.test(sentence) && !LONG_RE.test(sentence)) return { harness: 'Pi', reason: 'light · cheap · local → Pi' }
  if (REPO_RE.test(sentence) && !LONG_RE.test(sentence)) return { harness: 'Codex', reason: 'repo-wide → Codex' }
  if (LONG_RE.test(sentence)) return { harness: 'Claude Code', reason: 'long · multi-step · tests → Claude Code' }
  if (REPO_RE.test(sentence)) return { harness: 'Codex', reason: 'repo-wide → Codex' }
  return { harness: 'Claude Code', reason: 'a brief with no shape → Claude Code' }
}

/** "Delete every v1 route in the registry and keep the tests green" → "Prune v1 route". */
export function titleOf(sentence: string, max = 24): string {
  const cleaned = sentence.trim().replace(/[?？。.!！,，;；]+$/u, '')
  if (/[一-鿿]/.test(cleaned)) return cleaned.length > 14 ? `${cleaned.slice(0, 14).trimEnd()}…` : cleaned
  const picked = cleaned
    .split(/\s+/)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 3)
    .map((w) => w.replace(/^[a-z]/, (c) => c.toUpperCase()))
    .join(' ')
  const title = picked || cleaned
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title
}

// ── the decision ──────────────────────────────────────────────────────────

const IDLE: ReadonlySet<BoardPhase> = new Set(['done', 'unread', 'waiting'])

/** "2h", "40m" — how long since the card last moved. */
function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** A card matches on ANY role word, or on at least two content words of its last task — never on glue. */
export const TASK_OVERLAP_MIN = 2

export function decide(sentence: string, ctx: DecideContext): DecisionDraft {
  const said = words(sentence)
  const tier = exposure(sentence)
  const factsOf = (domain: Domain): DraftFacts => ({ domain, exposure: tier.score, exposureWhy: tier.why, boundaries: boundaries(tier.score, sentence) })
  if (isStatusQuestion(sentence)) {
    return { kind: 'question', question: statusAnswer(ctx), mode: 'answer', answer: statusAnswer(ctx), reasons: ['a status question', 'answered from the board', 'nothing is created'], ...factsOf('question') }
  }
  if (isQuestion(sentence)) {
    return { kind: 'question', question: questionBack(sentence), mode: 'question', answer: null, reasons: ['a question, not a brief', 'nothing is created', 'answer in the box'], ...factsOf('question') }
  }
  // A served card is somebody else's seat: never a target, never a bench.
  const own = ctx.candidates.filter((c) => !c.served)
  const sameRepo = own.filter((c) => ctx.workdir !== null && c.cwd === ctx.workdir)
  const idle = sameRepo.filter((c) => IDLE.has(c.phase) && !c.contextFull)
  const fit = idle
    .map((c) => {
      const role = overlap(words(`${c.role ?? ''}`), said)
      const touched = overlap(words(c.lastTask ?? ''), said)
      const taskHit = touched.length >= TASK_OVERLAP_MIN ? touched.length : 0
      return { c, role, touched, score: role.length * 2 + taskHit }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.lastActivityAt - a.c.lastActivityAt)
  const orch = sameRepo.find((c) => c.orch) ?? own.find((c) => c.orch) ?? null
  const picked = pickHarness(sentence, ctx.routing)
  const recruitPath: RecruitPath = { harness: picked.harness, name: titleOf(sentence), beside: orch ? { id: orch.id, name: orch.name } : null, direct: picked.direct }
  const recruitAlt: Alternate = { kind: 'recruit', id: `harness:${picked.harness}`, name: picked.harness, harness: picked.harness, reasons: [picked.reason] }
  if (fit.length > 0) {
    const reasonsOf = (x: (typeof fit)[number]): string[] => [
      x.c.phase === 'waiting' ? 'waiting' : 'idle',
      'same repo',
      x.role.length > 0 ? `role: ${x.c.role}` : `last touched ${x.touched.slice(0, 2).join(' ')} · ${ago(x.c.lastActivityAt, ctx.now)}`
    ]
    const [best, ...rest] = fit
    return {
      kind: 'ask',
      target: { id: best.c.id, name: best.c.name },
      // The next fit, then always the other path: a new card.
      alternates: [...rest.slice(0, 1).map((x): Alternate => ({ kind: 'ask', id: x.c.id, name: x.c.name, reasons: reasonsOf(x) })), recruitAlt],
      reasons: reasonsOf(best),
      recruit: recruitPath,
      ...factsOf('repo')
    }
  }
  // Nothing in the repo names this and nothing here can take it: a CHORE —
  // its own card outside the repo, Claude Code, no repo digest in the brief.
  if (!isRepoTask(sentence)) {
    const chore = ctx.routing?.defaultSet && ctx.routing.routable['Claude Code'] === false ? picked : { harness: 'Claude Code' as Harness, reason: 'a chore → Claude Code, outside the repo', direct: !ctx.routing?.defaultSet }
    return {
      kind: 'recruit',
      harness: chore.harness,
      name: titleOf(sentence),
      beside: null,
      alternates: [],
      direct: chore.direct,
      cwd: 'chores',
      reasons: ['not a repo task', chore.reason, 'a chore card in ~/.cookrew/chores, on the bench'],
      ...factsOf('chore')
    }
  }
  const alternates: Alternate[] = (['Claude Code', 'Codex', 'Pi'] as const)
    .filter((h) => h !== picked.harness && ctx.routing?.routable[h] !== false)
    .slice(0, 1)
    .map((h): Alternate => ({ kind: 'recruit', id: `harness:${h}`, name: h, harness: h, reasons: [`${h} instead`] }))
  // The other path for a recruit: the best idle card here, even though no word matched.
  const bench = [...idle].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  if (bench) alternates.push({ kind: 'ask', id: bench.id, name: bench.name, reasons: ['idle', 'same repo', `no word matched · ${ago(bench.lastActivityAt, ctx.now)}`] })
  return {
    kind: 'recruit',
    harness: picked.harness,
    name: recruitPath.name,
    beside: recruitPath.beside,
    alternates,
    direct: picked.direct,
    cwd: 'repo',
    reasons: [
      sameRepo.length === 0 ? 'no card in this repo' : idle.length === 0 ? 'every card here is busy or full' : 'no idle card fits the brief',
      picked.reason,
      orch ? `beside ${orch.name}, wired to it` : 'placed on the bench'
    ],
    ...factsOf('repo')
  }
}

// ── placement: the bench beside the orch, on the 110 px grid ─────────────

export const GRID = 110

export interface Box {
  position: { x: number; y: number }
  size: { width: number; height: number }
}

const overlaps = (a: Box, b: Box): boolean =>
  a.position.x < b.position.x + b.size.width &&
  a.position.x + a.size.width > b.position.x &&
  a.position.y < b.position.y + b.size.height &&
  a.position.y + a.size.height > b.position.y

const snap = (v: number): number => Math.round(v / GRID) * GRID

/**
 * The first free slot to the RIGHT of the anchor (then the next rows down),
 * snapped to the grid, never overlapping a card that is already there. With
 * no anchor the card goes to the right of everything, which is where a spoken
 * "create" has always landed.
 */
export function placeBeside(anchor: Box | null, nodes: readonly Box[], size: Box['size']): { x: number; y: number } {
  if (!anchor) {
    const right = nodes.reduce((max, n) => Math.max(max, n.position.x + n.size.width), 0)
    return { x: snap(right + GRID), y: snap(nodes[0]?.position.y ?? GRID) }
  }
  const startX = snap(anchor.position.x + anchor.size.width + GRID)
  const startY = snap(anchor.position.y)
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const candidate: Box = { position: { x: startX + col * GRID, y: startY + row * GRID }, size }
      if (!nodes.some((n) => overlaps(candidate, n))) return candidate.position
    }
  }
  return { x: startX, y: startY + 12 * GRID }
}
