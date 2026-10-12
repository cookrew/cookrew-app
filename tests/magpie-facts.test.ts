import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE GATEWAY FACTS EVERY LATER LANE BUILDS ON (route program, HP lane J0).
 *
 * Every file under tests/fixtures/magpie/ was recorded off the REAL magpie 0.1.1182 on
 * 127.0.0.1:3425 on 2026-10-12 (Ollama only; emails scrubbed). This file holds those recordings
 * to their shape — no gateway, no network, no product code — so that:
 *
 *   · a lane coding against System One, the rule object or `stays` can read one assertion instead
 *     of re-probing a live gateway, and
 *   · when someone re-records the fixtures against a newer magpie, whatever moved fails HERE,
 *     with the sentence saying which belief broke, rather than in the feature that trusted it.
 *
 * The companion report (docs/route-program/report-hp-facts.md) carries the source citations;
 * these are the bodies.
 */

const DIR = path.join(__dirname, 'fixtures', 'magpie')
const read = (file: string): string => readFileSync(path.join(DIR, file), 'utf8')
const json = <T>(file: string): T => JSON.parse(read(file)) as T

interface ErrorBody {
  error: { code: string | null; message: string; param: string | null; type: string }
}

interface RouteBody {
  route: {
    asked: string
    group?: string
    model: string
    served?: string
    rule?: { n: number; use?: string; when?: string[]; held?: boolean; turn?: number; tokens?: number; effort?: string }
    asked_effort?: string
    tries: { model: string; status: number; ms: number; done: boolean; effort?: string }[]
    done: boolean
    status: number
  }
  seq: number
  session: string
}

describe('System One (/v1/systemone) — the validation path, since no Jev provider exists here', () => {
  it('refuses a request that names no model, as an invalid_request_error', () => {
    const body = json<ErrorBody>('systemone-400-no-model.json')
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toBe('a System One request names no model')
  })

  it('refuses a routing group of CHAT models, and says what it wants instead', () => {
    const body = json<ErrorBody>('systemone-400-chat-group.json')
    expect(body.error.type).toBe('invalid_request_error')
    // The sentence is the contract: a group of DECISION models, or one `provider/model`.
    expect(body.error.message).toMatch(/holds models that hold conversations/)
    expect(body.error.message).toMatch(/System One asks a group of decision models, or a decision model as "provider\/model"/)
  })

  it('answers not_found for any decision model while the machine has no Jev provider', () => {
    const body = json<ErrorBody>('systemone-404-no-jev-provider.json')
    expect(body.error.type).toBe('not_found_error')
    expect(body.error.message).toBe('magpie has no Jev provider')
  })

  it('has no decision model in the chat catalog — every entry is type "model"', () => {
    const catalog = json<{ data: { id: string; type: string }[] }>('models.json')
    expect(catalog.data.length).toBeGreaterThan(0)
    expect([...new Set(catalog.data.map((m) => m.type))]).toEqual(['model'])
    // A Jev model would arrive from a Jev PROVIDER (gptload-jev, vercel-jev), never from these.
    expect(catalog.data.some((m) => /jev|typesafe|decision/i.test(m.id))).toBe(false)
  })
})

describe('one bearer, many cards — what a routing rule may match on', () => {
  const rules = json<{ accepted: string[]; refused: Record<string, string>; oneBearerProof: Record<string, { rule: { n: number; use?: string; when?: string[] }; model: string }> }>(
    'rule-conditions.json'
  )

  it('accepts thirteen conditions, and NONE of them is a header, a User-Agent or the model asked', () => {
    expect(rules.accepted).toEqual([
      'use',
      'pause',
      'tokens',
      'images',
      'effort',
      'agents',
      'intent',
      'compact',
      'time',
      'days',
      'folders',
      'classifier',
      'at'
    ])
    for (const form of Object.keys(rules.refused)) expect(rules.accepted).not.toContain(form.split('=')[0])
  })

  /**
   * `agents=` cannot do it: `agentOf()` takes the agent from the TOKEN first, so every card on
   * `magpie-cookrew` reads as one agent. `effort` DOES separate a reasoning turn from a plain one
   * on one bearer, which is what this records — but see route-with-rule.json: a Cookrew claude
   * card asks for `high` effort too, so `effort=on` is not the codex/claude discriminator the
   * first draft of this lane's report took it for.
   */
  it('separates a reasoning turn from a plain one on the same bearer', () => {
    expect(rules.oneBearerProof.plain.rule.n).toBe(0)
    expect(rules.oneBearerProof.plain.model).toBe('ollama/qwen2.5:1.5b')
    expect(rules.oneBearerProof.reasoning.rule.when).toEqual(['reasoning'])
    expect(rules.oneBearerProof.reasoning.rule.use).toBe('ollama/qwen3:1.7b')
    expect(rules.oneBearerProof.reasoning.model).toBe('ollama/qwen3:1.7b')
  })
})

describe('the rule object on the route read-back — what RouteDecision.rule must be built from', () => {
  const hit = json<RouteBody>('route-hp-think.json')
  const miss = json<RouteBody>('route-hp-plain.json')

  it('names the rule by NUMBER and the pick by `use`, with the conditions in `when`', () => {
    expect(hit.route.rule?.n).toBe(1)
    expect(hit.route.rule?.use).toBe('ollama/qwen3:1.7b')
    expect(hit.route.rule?.when).toEqual(['reasoning'])
    expect(hit.route.asked).toBe('group/think')
    expect(hit.route.group).toBe('think')
    expect(hit.route.asked_effort).toBe('high')
  })

  it('says `n: 0` with no `use` when no rule matched — which is NOT the same as no rule object', () => {
    expect(miss.route.rule).toBeDefined()
    expect(miss.route.rule?.n).toBe(0)
    expect(miss.route.rule?.use).toBeUndefined()
  })

  /**
   * The HP contract asks for `RouteDecision.rule = { id: string; pick: string | null }`. The
   * gateway gives `{ n, use, when, turn, tokens, effort }`, so the adapter is the mapping pinned
   * here — and `n: 0` must become `null`, or the rail will print "auto → rule 0 → …" for a turn
   * no rule touched.
   */
  it('maps to the contract: id ← n, pick ← use, and a miss is null', () => {
    const toContract = (route: RouteBody['route']): { id: string; pick: string | null } | null =>
      route.rule && route.rule.n > 0 ? { id: String(route.rule.n), pick: route.rule.use ?? null } : null
    expect(toContract(hit.route)).toEqual({ id: '1', pick: 'ollama/qwen3:1.7b' })
    expect(toContract(miss.route)).toBeNull()
  })

  it('records the attempt that answered, with its own effort and timing', () => {
    expect(hit.route.tries).toHaveLength(1)
    expect(hit.route.tries[0]).toMatchObject({ model: 'ollama/qwen3:1.7b', status: 200, done: true, effort: 'high' })
    expect(hit.route.tries[0].ms).toBeGreaterThan(0)
    expect(hit.route.done).toBe(true)
    expect(hit.route.status).toBe(200)
  })
})

describe('stays — and the leak that one gateway key makes of it', () => {
  const stays = json<{ session: Record<string, string>; turn: Record<string, string>; finding: string }>('stays.json')

  /**
   * MEASURED, AND IT IS A HAZARD FOR COOKREW: with `stays=session` a pin made by ONE session is
   * inherited by sessions that never asked for it — the scope is the BEARER, not
   * `X-Magpie-Session`. Every Cookrew card shares one key today, so one card's reasoning turn
   * would silently move every other card on that group onto the same member.
   */
  it('lets one session’s pin decide a brand-new session’s model when stays=session', () => {
    const picked = Object.values(stays.session)
    expect(new Set(picked).size).toBe(1)
    expect(picked[0]).toBe('ollama/qwen3:1.7b')
    expect(Object.keys(stays.session).filter((k) => k.includes('NEW session'))).toHaveLength(2)
  })

  it('re-decides every turn when stays=turn, so a plain turn goes back to the group’s first member', () => {
    expect(stays.turn['hp-x2 (reasoning)']).toBe('ollama/qwen3:1.7b')
    expect(stays.turn['hp-y2 (plain, NEW session)']).toBe('ollama/qwen2.5:1.5b')
  })
})

describe('gateway-key — key scoping exists, and nothing here minted one', () => {
  const help = read('gateway-key-help.txt')

  it('offers models and a limit per key, and lists accounts as a column', () => {
    expect(help).toMatch(/gateway-key list\|add <name>\|rotate <id>\|remove <id>/)
    expect(help).toMatch(/gateway-key limit <id> \[off\|reset\|day\|week\|month\|<N>d --tokens N --cost USD --cache-reads\]/)
    expect(help).toMatch(/gateway-key models <id> \[all\|<provider>\/<model>\|<provider>\/\* \.\.\.\]/)
    expect(help).toMatch(/ID\s+NAME\s+STATE\s+GATEWAY KEY\s+LIMIT\s+MODELS\s+ACCOUNTS/)
  })

  it('records an EMPTY key list: the bearer works because the gateway takes any key from this machine', () => {
    const table = help.split('\n').filter((l) => /^\s*\d/.test(l))
    expect(table).toEqual([])
  })
})

describe('a REAL rule hit, driven by claude -p through a scratch group (route-with-rule.json)', () => {
  const body = json<RouteBody>('route-with-rule.json')

  /**
   * Recorded for Forge: fix/hp-route mapped `RouteDecision.rule` from a body synthesised out of
   * the docs, because no group on this machine had a rule. This one is real — `group/hp-rule`
   * with `[ollama/qwen2.5:3b, ollama/qwen2.5:1.5b]` in order and one rule
   * (`use=ollama/qwen2.5:1.5b tokens=1k`), asked by a real `claude -p` under
   * `X-Magpie-Session: cookrew:probe-rule`. The group is removed again; the body is the fixture.
   */
  it('names the rule by number and the pick by `use` — NOT `id` and `pick`', () => {
    expect(body.route.rule?.n).toBe(1)
    expect(body.route.rule?.use).toBe('ollama/qwen2.5:1.5b')
    expect(body.route.rule?.when).toEqual(['tokens ≥ 1000'])
    // The rule beat the group's own order: member 1 is qwen2.5:3b.
    expect(body.route.model).toBe('ollama/qwen2.5:1.5b')
    expect(body.route.asked).toBe('group/hp-rule')
    const keys = Object.keys(body.route.rule ?? {})
    expect(keys).not.toContain('id')
    expect(keys).not.toContain('pick')
  })

  /**
   * `held: true` is "decided when the turn began" (internal/gateway/rules.go:31, set at :217).
   * A claude turn makes several requests — system prompt, then tool results — and the later ones
   * report the rule the turn opened on rather than a fresh match. A rail that treats `held` as a
   * new decision would redraw the same rule all turn.
   */
  it('marks a within-turn decision as held', () => {
    expect(body.route.rule?.held).toBe(true)
    expect(body.route.rule?.turn).toBe(1)
    expect(body.route.rule?.tokens).toBeGreaterThan(1000)
  })

  /**
   * THE CORRECTION TO THIS LANE'S OWN §3. A Cookrew claude card asks for `high` effort — the
   * banner says so at boot and the route body says so here — so `effort=on` matches claude
   * traffic too and CANNOT be the thing that sends codex to thinking models and leaves claude
   * alone. Pinned so the recommendation cannot be read off the earlier fixture alone.
   */
  it('shows a claude turn asking for high effort, which breaks the effort=on discriminator', () => {
    expect(body.route.asked_effort).toBe('high')
    expect(body.route.rule?.effort).toBe('high')
  })

  it('maps to the HP contract the same way a curl-driven hit does', () => {
    const toContract = (route: RouteBody['route']): { id: string; pick: string | null } | null =>
      route.rule && route.rule.n > 0 ? { id: String(route.rule.n), pick: route.rule.use ?? null } : null
    expect(toContract(body.route)).toEqual({ id: '1', pick: 'ollama/qwen2.5:1.5b' })
  })
})

describe('gateway-key models — a group id is accepted, unvalidated, and enforced', () => {
  const rec = json<{
    accepted: Record<string, string>
    validated: boolean
    enforced: boolean
    enforcement: Record<string, number>
  }>('gateway-key-groups.json')

  /** For Tinker: scripts/magpie-sous-key.sh passes `group/jevs group/auto`, and the CLI takes them. */
  it('takes group ids on the command line, including ones no group answers to', () => {
    expect(rec.accepted['group/think (a group that exists)']).toBe('hp-facts probe: only group/think')
    expect(rec.accepted["group/jevs group/auto (Tinker's exact arguments; NEITHER group exists here)"]).toBe(
      'hp-facts probe: only group/jevs, group/auto'
    )
    expect(rec.validated).toBe(false)
  })

  it('enforces the scope at the gateway: in-scope 200, out-of-scope 403', () => {
    expect(rec.enforced).toBe(true)
    expect(rec.enforcement['models=group/think, POST /v1/chat/completions model=group/think']).toBe(200)
    expect(rec.enforcement['models=group/think, POST /v1/chat/completions model=ollama/qwen2.5:1.5b']).toBe(403)
  })

  it('refuses with a sentence that names the key and what it may use', () => {
    const body = json<ErrorBody>('gateway-key-403-out-of-scope.json')
    expect(body.error.message).toMatch(/may not use ollama\/qwen2\.5:1\.5b/)
    expect(body.error.message).toMatch(/it may use group\/think/)
    // The sentence names the key by NAME, never by credential.
    expect(body.error.message).not.toMatch(/sk-magpie-key/)
  })
})

describe('what each harness actually asks for — the measurement §6 said would decide it', () => {
  const matrix = json<{ asked: Record<string, string>; thresholds: Record<string, string>; answer: string }>('effort-matrix.json')
  const route = (file: string): RouteBody => json<RouteBody>(file)

  /**
   * Spawned with the EXACT args src/main/route-env.ts composes (codex: the seven `-c` pairs;
   * claude: the env), model `group/think`, one session per level. The turns are recorded off
   * /v1/magpie/route, which stamps `asked_effort` when the request ARRIVES — so the reading does
   * not depend on a local model answering well.
   */
  it('records claude at high and codex at medium on Cookrew’s own defaults', () => {
    expect(route('route-claude-effort.json').route.asked_effort).toBe('high')
    expect(route('route-codex-effort-default.json').route.asked_effort).toBe('medium')
    expect(matrix.asked["claude -p, Cookrew's routeEnv env, model group/think"]).toBe('high')
    expect(matrix.asked["codex exec, Cookrew's routeEnv args, NO model_reasoning_effort (the default)"]).toBe('medium')
  })

  it('passes an explicit -c model_reasoning_effort straight through', () => {
    expect(route('route-codex-effort-low.json').route.asked_effort).toBe('low')
    expect(route('route-codex-effort-medium.json').route.asked_effort).toBe('medium')
    expect(route('route-codex-effort-high.json').route.asked_effort).toBe('high')
  })

  it('reaches the same member every time, so the effort is the only variable', () => {
    for (const file of ['route-claude-effort.json', 'route-codex-effort-default.json', 'route-codex-effort-low.json', 'route-codex-effort-medium.json', 'route-codex-effort-high.json']) {
      expect(route(file).route.model, file).toBe('ollama/qwen3:1.7b')
      expect(route(file).route.status, file).toBe(200)
    }
  })

  /**
   * THE ANSWER, AND IT IS NO. `effort=<level>` is a >= predicate (proven on a scratch group: the
   * rule renders "effort ≥ high", a medium request misses it, a high request hits it). Cookrew's
   * claude asks HIGH and Cookrew's codex asks MEDIUM, so the ordering is inverted — no >= cut can
   * select the lower level and exclude the higher. `effort=on` and `effort=medium` take both;
   * `effort=high` takes claude alone, which is backwards; `xhigh` takes neither.
   */
  it('leaves no threshold that selects codex and excludes claude', () => {
    const [claude, codex] = ['high', 'medium']
    const order = ['low', 'medium', 'high', 'xhigh', 'max']
    const atLeast = (level: string, asked: string): boolean => order.indexOf(asked) >= order.indexOf(level)
    const useful = order.filter((level) => atLeast(level, codex) && !atLeast(level, claude))
    expect(useful).toEqual([])
    // and the one threshold that does separate them picks the wrong harness
    expect(order.filter((level) => atLeast(level, claude) && !atLeast(level, codex))).toEqual(['high'])
    expect(matrix.thresholds['effort=high']).toMatch(/CLAUDE only/)
    expect(matrix.answer).toMatch(/^NO\./)
  })
})

describe('the fixtures themselves', () => {
  it('carry no email address', () => {
    for (const file of ['providers.txt', 'models.json', 'group-think.txt', 'gateway-key-help.txt', 'route-with-rule.json', 'gateway-key-groups.json']) {
      expect(read(file), file).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    }
  })
})
