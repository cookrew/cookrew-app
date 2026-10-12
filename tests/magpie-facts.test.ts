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
    rule?: { n: number; use?: string; when?: string[]; turn?: number; tokens?: number; effort?: string }
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
   * THE ANSWER TO "can codex get thinking models while claude does not, under one key": yes, but
   * not through `agents=`. `agentOf()` takes the agent from the TOKEN first, so every card on
   * `magpie-cookrew` reads as one agent. `effort=on` is the condition that still separates them,
   * because codex asks for reasoning on the Responses path and a Cookrew claude card does not.
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

describe('the fixtures themselves', () => {
  it('carry no email address', () => {
    for (const file of ['providers.txt', 'models.json', 'group-think.txt', 'gateway-key-help.txt']) {
      expect(read(file), file).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    }
  })
})
