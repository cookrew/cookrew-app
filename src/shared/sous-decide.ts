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
}

export interface DecideContext {
  candidates: readonly DecideCandidate[]
  /** The active workspace's directory. */
  workdir: string | null
  now: number
}

export interface Alternate {
  id: string
  name: string
  reasons: string[]
}

export type DecisionDraft =
  | { kind: 'ask'; target: { id: string; name: string }; alternates: Alternate[]; reasons: string[] }
  | {
      kind: 'recruit'
      harness: Harness
      /** The new card's name — the sentence, shortened to a title. */
      name: string
      /** The orch the card is placed beside and wired to, when the workdir has one. */
      beside: { id: string; name: string } | null
      alternates: Alternate[]
      reasons: string[]
    }
  | { kind: 'question'; question: string; reasons: string[] }

/** How long the box holds the echo before committing on its own. */
export const DECISION_HOLD_MS = 1500
/** How long main keeps an uncommitted decision before it expires. */
export const DECISION_TTL_MS = 30_000

// ── words ─────────────────────────────────────────────────────────────────

const STOP = new Set(
  'the a an and or of to in on for with into from by at as is are be this that it its my our your please make add fix do all every keep then also just 把 的 了 和 与 并 在 给 让 要 一个 这个 那个 所有 全部 一下'.split(' ')
)

/** Lowercased content words; CJK runs become overlapping bigrams so "安装一节" and "安装" meet. */
export function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*|[一-鿿]+/g) ?? []) {
    if (/^[一-鿿]+$/.test(token)) {
      if (token.length === 1) continue
      for (let i = 0; i + 1 < token.length || i === 0; i++) {
        const bigram = token.slice(i, i + 2)
        if (!STOP.has(bigram)) out.add(bigram)
      }
      continue
    }
    if (token.length < 2 || STOP.has(token)) continue
    out.add(token.replace(/^[./-]+|[./-]+$/g, ''))
  }
  return out
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
  if (PLAN_RE.test(s) && words(s).size <= 3) return true
  // Two words with no verb anyone could act on is a remark, not a brief.
  return words(s).size <= 2 && !TASK_VERB_RE.test(s)
}

/** What Sous asks back — it names the sentence, so the owner sees what was heard. */
export function questionBack(sentence: string): string {
  const s = sentence.trim().replace(/[?？。.!！]+$/u, '')
  return /[一-鿿]/.test(s) ? `「${s}」——这是要我做的事，还是问我的问题？说清楚派给谁，或者直接告诉我做什么。` : `“${s}” — is that a task for the crew, or a question for me? Name who, or say what to do.`
}

// ── harness by task shape ─────────────────────────────────────────────────

const LONG_RE = /\b(?:tests?|spec|ci|e2e|end.to.end|multi.?step|pipeline|feature|implement|build|migrate|across|several|many files)\b|(?:测试|多步|功能|实现|迁移|流水线|端到端|多个文件)/iu
const REPO_RE = /\b(?:repo-?wide|whole repo|every|all|refactor|review|audit|rename across|prune|delete every|clean ?up|lint|dead code)\b|(?:全仓|整个仓库|所有|全部|重构|评审|审计|清理|死代码)/iu
const LIGHT_RE = /\b(?:quick|small|tiny|cheap|local|offline|explain|summari[sz]e|what does|look up|draft|one.?liner|typo)\b|(?:快速|小改|便宜|本地|离线|解释|总结|看看|草稿|错别字)/iu

export function pickHarness(sentence: string): { harness: Harness; reason: string } {
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
    .filter((w) => !STOP.has(w.toLowerCase()))
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

export function decide(sentence: string, ctx: DecideContext): DecisionDraft {
  const said = words(sentence)
  if (isQuestion(sentence)) {
    return { kind: 'question', question: questionBack(sentence), reasons: ['a question, not a brief', 'nothing is created', 'answer in the box'] }
  }
  const sameRepo = ctx.candidates.filter((c) => ctx.workdir !== null && c.cwd === ctx.workdir)
  const fit = sameRepo
    .filter((c) => IDLE.has(c.phase) && !c.contextFull)
    .map((c) => {
      const role = overlap(words(`${c.role ?? ''}`), said)
      const touched = overlap(words(c.lastTask ?? ''), said)
      return { c, role, touched, score: role.length * 2 + touched.length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.lastActivityAt - a.c.lastActivityAt)
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
      alternates: rest.slice(0, 2).map((x) => ({ id: x.c.id, name: x.c.name, reasons: reasonsOf(x) })),
      reasons: reasonsOf(best)
    }
  }
  const { harness, reason } = pickHarness(sentence)
  const orch = sameRepo.find((c) => c.orch) ?? ctx.candidates.find((c) => c.orch) ?? null
  const idleButWrong = sameRepo.filter((c) => IDLE.has(c.phase) && !c.contextFull).length
  const alternates: Alternate[] = (['Claude Code', 'Codex', 'Pi'] as const)
    .filter((h) => h !== harness)
    .slice(0, 1)
    .map((h) => ({ id: `harness:${h}`, name: h, reasons: [`${h} instead`] }))
  return {
    kind: 'recruit',
    harness,
    name: titleOf(sentence),
    beside: orch ? { id: orch.id, name: orch.name } : null,
    alternates,
    reasons: [
      sameRepo.length === 0 ? 'no card in this repo' : idleButWrong === 0 ? 'every card here is busy or full' : 'no idle card fits the brief',
      reason,
      orch ? `beside ${orch.name}, wired to it` : 'placed on the bench'
    ]
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
