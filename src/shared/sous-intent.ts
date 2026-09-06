// Sous, asked to DRIVE the canvas instead of title a turn.
//
// A spoken sentence — from the Mac's ⌘-hold, the phone's 🎙️, the speaker in
// the living room, or `cookrew sous "…"` — becomes one intent from a closed
// set, resolved against the live roster. Deterministic on purpose: every
// sentence in the owner's ask is covered by grammar, so the small model is
// never in the loop for the common path (the caller may try it on `none`).
//
// Two rules carried over from the CLI (resolveSelfByName): a name is matched,
// never guessed — ambiguity asks back with the choices — and free text has
// exactly one sink, the PTY of an agent the owner named, as a prompt.

export type Surface = 'canvas' | 'zoom' | 'phone' | 'home' | 'cli'

export interface RosterAgent {
  id: string
  name: string
  workspaceId: string
  workspaceName: string
  /** Other ways the owner says this name — 指挥 for Conductor. */
  aliases?: readonly string[]
}

export interface IntentRoster {
  agents: ReadonlyArray<RosterAgent>
  workspaces: ReadonlyArray<{ id: string; name: string }>
  presets: ReadonlyArray<string>
}

/** A question Sous asked and is still waiting on: "需要问 Conductor 什么呢？" */
export interface PendingPrompt {
  kind: 'prompt'
  agentId: string
  /** Absolute ms; a slot that outlives this is not a slot. */
  until: number
}

export interface IntentContext {
  surface: Surface
  activeWorkspaceId: string | null
  /** In the zoom view, the agent whose terminal fills the screen. */
  focusedAgentId?: string | null
  pending?: PendingPrompt | null
}

export type SousIntent =
  | { kind: 'switch'; workspaceId: string }
  | { kind: 'ask'; agentId: string; prompt: string | null }
  | { kind: 'prompt'; agentId: string; text: string }
  | { kind: 'create'; preset: string; workspaceId: string | null; browser: boolean }
  | { kind: 'connect'; fromId: string; toId: string }
  | { kind: 'rename'; agentId: string; to: string }
  | { kind: 'back' }
  | { kind: 'open' }
  | { kind: 'none' }

export type Refusal =
  | 'which-agent'
  | 'which-workspace'
  | 'unknown-agent'
  | 'unknown-workspace'
  | 'unknown-preset'
  | 'bad-name'

export type Parsed =
  | { ok: true; intent: SousIntent; spoken: string; lang: Lang }
  | { ok: false; needs: Refusal; spoken: string; choices?: string[]; said: string; lang: Lang }

export type Lang = 'zh' | 'en'

/** How long Sous waits for the answer to "what should I ask X?". */
export const PENDING_PROMPT_MS = 25_000

/** Longest name a card may be given by voice — past this it was a sentence. */
const MAX_NAME_CHARS = 40

// ── names ─────────────────────────────────────────────────────────────────

interface Named {
  name: string
  aliases?: readonly string[]
}

export type NameHit<T extends Named> = { hit: T } | { ambiguous: T[] } | { miss: true }

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\s_\-·.]+/g, '')
    .trim()

/**
 * exact → alias → unique prefix; two prefix hits are an ambiguity, not a
 * choice made for the owner. Normalized so "claude-code", "Claude Code" and
 * "claude_code" are one name — ASR never spells punctuation the same way twice.
 */
export function resolveName<T extends Named>(said: string, pool: ReadonlyArray<T>): NameHit<T> {
  const wanted = normalize(said)
  if (wanted === '') return { miss: true }
  const exact = pool.filter((p) => normalize(p.name) === wanted)
  if (exact.length === 1) return { hit: exact[0] }
  if (exact.length > 1) return { ambiguous: exact }
  const alias = pool.filter((p) => (p.aliases ?? []).some((a) => normalize(a) === wanted))
  if (alias.length === 1) return { hit: alias[0] }
  if (alias.length > 1) return { ambiguous: alias }
  const prefix = pool.filter((p) => normalize(p.name).startsWith(wanted))
  if (prefix.length === 1) return { hit: prefix[0] }
  if (prefix.length > 1) return { ambiguous: prefix }
  return { miss: true }
}

// ── grammar ───────────────────────────────────────────────────────────────

const CJK_RE = /\p{Script=Han}/u
const TRAILING_PUNCT_RE = /[\s。．.!！?？,，;；]+$/u
/** "Sous, …" / "苏斯，…" — the address that makes prose a command in the zoom view. */
const SOUS_ADDRESS_RE = /^(?:sous|苏斯|小厨)\s*[,，:：、]?\s*/iu
const BROWSER_EN_RE = /\s+with\s+(?:a\s+|an\s+)?browser\b/i
const BROWSER_ZH_RE = /\s*(?:带|加|配|和)\s*(?:一个|个)?\s*浏览器/u
const SEP = '[，,：:]'

interface Shape {
  kind: 'switch' | 'ask' | 'create' | 'connect' | 'rename' | 'back' | 'open'
  re: RegExp
  /** Which capture holds what; groups not listed are absent for the shape. */
  slots: Partial<Record<'workspace' | 'agent' | 'prompt' | 'preset' | 'from' | 'to' | 'name', number>>
}

// Longest alternative first inside each group — "切换工作台到" must not be
// eaten as "切换" + "工作台到…". Order across shapes matters too: back/open
// are exact, then the verbs that cannot be confused, then the wide ones.
const SHAPES: Shape[] = [
  { kind: 'back', re: /^(?:回到画布|回画布|退出画面|退出|返回|back(?:\s+to\s+(?:the\s+)?canvas)?|canvas|zoom\s*out)$/iu, slots: {} },
  { kind: 'open', re: /^(?:帮我)?(?:打开|开启|open)\s*cookrew$/iu, slots: {} },
  {
    kind: 'rename',
    re: /^(?:把|将)?\s*(.+?)\s*(?:改名为|改名叫|改名成|重命名为|重命名成|改叫)\s*(.*)$/u,
    slots: { from: 1, name: 2 }
  },
  { kind: 'rename', re: /^rename\s+(.+?)\s+(?:to|as)\s*(.*)$/iu, slots: { from: 1, name: 2 } },
  {
    kind: 'connect',
    re: /^(?:把|将)?\s*(.+?)\s*(?:连接到|连到|连上|接到|连接)\s*(.+)$/u,
    slots: { from: 1, to: 2 }
  },
  { kind: 'connect', re: /^(?:link|connect)\s+(.+?)\s+(?:to|and|with)\s+(.+)$/iu, slots: { from: 1, to: 2 } },
  {
    kind: 'create',
    re: /^(?:在\s*(.+?)\s*)?(?:帮我)?(?:创建|新建|建|加)\s*(?:一个|个)?\s*(.+)$/u,
    slots: { workspace: 1, preset: 2 }
  },
  {
    kind: 'create',
    re: /^(?:create|add|new|spawn)\s+(?:a\s+|an\s+)?(.+?)(?:\s+(?:on|in)\s+(.+))?$/iu,
    slots: { preset: 1, workspace: 2 }
  },
  {
    kind: 'switch',
    re: /^(?:帮我)?(?:切换工作台到|切换到工作台|切换到|切换|切到|去)\s*(.+)$/u,
    slots: { workspace: 1 }
  },
  {
    kind: 'switch',
    re: /^(?:switch|go)(?:\s+to)?(?:\s+(?:the\s+)?workspace)?\s+(.+)$/iu,
    slots: { workspace: 1 }
  },
  {
    kind: 'ask',
    re: new RegExp(`^(?:在\\s*(.+?)\\s*)?(?:帮我)?(?:问问|问一下|问|找一下|找|叫|呼叫|转到)\\s*(.+?)(?:\\s*${SEP}\\s*(.+))?$`, 'u'),
    slots: { workspace: 1, agent: 2, prompt: 3 }
  },
  {
    kind: 'ask',
    re: new RegExp(
      `^(?:ask|turn\\s*-?\\s*to|focus(?:\\s+on)?|talk\\s+to)\\s+(.+?)(?:\\s+(?:on|in)\\s+(.+?))?(?:\\s*${SEP}\\s*(.+))?$`,
      'iu'
    ),
    slots: { agent: 1, workspace: 2, prompt: 3 }
  }
]

interface Match {
  kind: Shape['kind']
  workspace?: string
  agent?: string
  prompt?: string
  preset?: string
  from?: string
  to?: string
  name?: string
  browser: boolean
}

function matchShape(text: string): Match | null {
  const browser = BROWSER_EN_RE.test(text) || BROWSER_ZH_RE.test(text)
  const bare = text.replace(BROWSER_EN_RE, '').replace(BROWSER_ZH_RE, '').trim()
  for (const shape of SHAPES) {
    const m = shape.re.exec(bare)
    if (!m) continue
    const pick = (slot: keyof Shape['slots']): string | undefined => {
      const index = shape.slots[slot]
      const value = index === undefined ? undefined : m[index]
      return value === undefined ? undefined : value.trim()
    }
    return {
      kind: shape.kind,
      workspace: pick('workspace'),
      agent: pick('agent'),
      prompt: pick('prompt'),
      preset: pick('preset'),
      from: pick('from'),
      to: pick('to'),
      name: pick('name'),
      browser
    }
  }
  return null
}

// ── spoken replies ────────────────────────────────────────────────────────

export function langOf(text: string): Lang {
  return CJK_RE.test(text) ? 'zh' : 'en'
}

const SPOKEN = {
  zh: {
    switch: (ws: string) => `好的，切到 ${ws}`,
    askBack: (agent: string) => `需要问 ${agent} 什么呢？`,
    sent: (agent: string) => `已发给 ${agent}`,
    created: (preset: string, ws: string | null, browser: boolean) =>
      `建好了，${preset}${ws ? ` 在 ${ws}` : ''}${browser ? '，带浏览器' : ''}`,
    connected: (a: string, b: string) => `已连接 ${a} 和 ${b}`,
    renamed: (from: string, to: string) => `${from} 现在叫 ${to}`,
    open: () => 'Cookrew 已打开',
    which: (choices: string[]) => `你是说 ${choices.join(' 还是 ')}？`,
    unknownAgent: (said: string) => `没有叫 ${said} 的 agent`,
    unknownWorkspace: (said: string) => `没有叫 ${said} 的工作台`,
    unknownPreset: (said: string) => `没有 ${said} 这个 preset`,
    badName: () => '新名字要短一点，一到四十个字'
  },
  en: {
    switch: (ws: string) => `Switching to ${ws}`,
    askBack: (agent: string) => `What should I ask ${agent}?`,
    sent: (agent: string) => `Sent to ${agent}`,
    created: (preset: string, ws: string | null, browser: boolean) =>
      `Created ${preset}${ws ? ` on ${ws}` : ''}${browser ? ' with a browser' : ''}`,
    connected: (a: string, b: string) => `Connected ${a} and ${b}`,
    renamed: (from: string, to: string) => `${from} is now ${to}`,
    open: () => 'Cookrew is open',
    which: (choices: string[]) => `Did you mean ${choices.join(' or ')}?`,
    unknownAgent: (said: string) => `No agent named ${said}`,
    unknownWorkspace: (said: string) => `No workspace named ${said}`,
    unknownPreset: (said: string) => `No preset named ${said}`,
    badName: () => 'A name needs one to forty characters'
  }
} as const

// ── the parser ────────────────────────────────────────────────────────────

/**
 * One sentence in, one intent or one refusal out. `now` decides whether a
 * pending slot is still open; it is a parameter so the tests own the clock.
 */
export function parseUtterance(
  raw: string,
  ctx: IntentContext,
  roster: IntentRoster,
  now: number = Date.now()
): Parsed {
  const trimmed = raw.trim().replace(TRAILING_PUNCT_RE, '')
  const lang = langOf(trimmed)
  const addressed = SOUS_ADDRESS_RE.test(trimmed)
  const text = trimmed.replace(SOUS_ADDRESS_RE, '').trim()
  if (text === '') return { ok: true, intent: { kind: 'none' }, spoken: '', lang }

  // In the zoom view the terminal IS the input: prose is a prompt for the
  // agent on screen, and only a sentence addressed to Sous is a command.
  // "rename foo to bar" is something you say TO an agent.
  if (ctx.surface === 'zoom' && !addressed) {
    if (ctx.focusedAgentId) return promptFor(ctx.focusedAgentId, text, roster, lang)
    return { ok: true, intent: { kind: 'none' }, spoken: '', lang }
  }

  const match = matchShape(text)
  if (match) return resolve(match, ctx, roster, lang, text)

  // Sous asked "what should I ask X?" — this is the answer, unless it was a
  // command, which the shape check above already took.
  const pending = ctx.pending
  if (pending && pending.until > now) return promptFor(pending.agentId, text, roster, lang)

  return { ok: true, intent: { kind: 'none' }, spoken: '', lang }
}

function promptFor(agentId: string, text: string, roster: IntentRoster, lang: Lang): Parsed {
  const agent = roster.agents.find((a) => a.id === agentId)
  return {
    ok: true,
    intent: { kind: 'prompt', agentId, text },
    spoken: SPOKEN[lang].sent(agent?.name ?? agentId),
    lang
  }
}

type Resolved<T> = { ok: true; value: T } | { ok: false; refusal: Parsed & { ok: false } }

function resolve(match: Match, ctx: IntentContext, roster: IntentRoster, lang: Lang, said: string): Parsed {
  const copy = SPOKEN[lang]
  const refuse = (needs: Refusal, spoken: string, choices?: string[]): Parsed => ({
    ok: false,
    needs,
    spoken,
    ...(choices ? { choices } : {}),
    said,
    lang
  })

  const workspace = (name: string | undefined): Resolved<{ id: string; name: string } | null> => {
    if (name === undefined || name === '') return { ok: true, value: null }
    const hit = resolveName(name, roster.workspaces)
    if ('hit' in hit) return { ok: true, value: hit.hit }
    if ('ambiguous' in hit) {
      const names = hit.ambiguous.map((w) => w.name)
      return { ok: false, refusal: refuse('which-workspace', copy.which(names), names) as Parsed & { ok: false } }
    }
    return { ok: false, refusal: refuse('unknown-workspace', copy.unknownWorkspace(name)) as Parsed & { ok: false } }
  }

  // An agent named with a workspace is looked for there; named alone, the
  // active workspace's agent wins a tie, and a tie with no active workspace
  // is asked back with the workspaces spelled out.
  const agent = (name: string | undefined, scope: string | null): Resolved<RosterAgent> => {
    const pool = scope ? roster.agents.filter((a) => a.workspaceId === scope) : roster.agents
    let hit = resolveName(name ?? '', pool)
    if ('ambiguous' in hit && !scope && ctx.activeWorkspaceId) {
      const local = hit.ambiguous.filter((a) => a.workspaceId === ctx.activeWorkspaceId)
      if (local.length === 1) hit = { hit: local[0] }
    }
    if ('hit' in hit) return { ok: true, value: hit.hit }
    if ('ambiguous' in hit) {
      const choices = hit.ambiguous.map((a) => `${a.name} (${a.workspaceName})`)
      return { ok: false, refusal: refuse('which-agent', copy.which(choices), choices) as Parsed & { ok: false } }
    }
    return { ok: false, refusal: refuse('unknown-agent', copy.unknownAgent(name ?? '')) as Parsed & { ok: false } }
  }

  switch (match.kind) {
    case 'back':
      return { ok: true, intent: { kind: 'back' }, spoken: '', lang }
    case 'open':
      return { ok: true, intent: { kind: 'open' }, spoken: copy.open(), lang }
    case 'switch': {
      const ws = workspace(match.workspace)
      if (!ws.ok) return ws.refusal
      if (!ws.value) return refuse('unknown-workspace', copy.unknownWorkspace(''))
      return { ok: true, intent: { kind: 'switch', workspaceId: ws.value.id }, spoken: copy.switch(ws.value.name), lang }
    }
    case 'ask': {
      const ws = workspace(match.workspace)
      if (!ws.ok) return ws.refusal
      const who = agent(match.agent, ws.value?.id ?? null)
      if (!who.ok) return who.refusal
      const prompt = match.prompt && match.prompt !== '' ? match.prompt : null
      return {
        ok: true,
        intent: { kind: 'ask', agentId: who.value.id, prompt },
        spoken: prompt ? copy.sent(who.value.name) : copy.askBack(who.value.name),
        lang
      }
    }
    case 'create': {
      const ws = workspace(match.workspace)
      if (!ws.ok) return ws.refusal
      const preset = resolveName(match.preset ?? '', roster.presets.map((name) => ({ name })))
      if (!('hit' in preset)) return refuse('unknown-preset', copy.unknownPreset(match.preset ?? ''))
      return {
        ok: true,
        intent: { kind: 'create', preset: preset.hit.name, workspaceId: ws.value?.id ?? null, browser: match.browser },
        spoken: copy.created(preset.hit.name, ws.value?.name ?? null, match.browser),
        lang
      }
    }
    case 'connect': {
      const from = agent(match.from, null)
      if (!from.ok) return from.refusal
      const to = agent(match.to, null)
      if (!to.ok) return to.refusal
      return {
        ok: true,
        intent: { kind: 'connect', fromId: from.value.id, toId: to.value.id },
        spoken: copy.connected(from.value.name, to.value.name),
        lang
      }
    }
    case 'rename': {
      const from = agent(match.from, null)
      if (!from.ok) return from.refusal
      const to = (match.name ?? '').trim()
      if (to === '' || to.length > MAX_NAME_CHARS) return refuse('bad-name', copy.badName())
      return {
        ok: true,
        intent: { kind: 'rename', agentId: from.value.id, to },
        spoken: copy.renamed(from.value.name, to),
        lang
      }
    }
  }
}
