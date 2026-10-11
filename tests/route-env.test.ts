// THE EXACT ENV AND ARGS EACH HARNESS IS SPAWNED WITH WHEN ROUTED (route
// program, 2026-10-11). Pinned line by line: these are the lines the real
// claude 2.1.275 and codex 0.162.1 were seen to honour against a fake
// gateway (src/main/route-env.ts header), so a drift here is a drift from
// what was verified.

import { describe, expect, it } from 'vitest'
import { routeEnv, sessionHeaderLine } from '../src/main/route-env'
import { shellQuote } from '../src/main/shell-quote'
import { routeSession } from '../src/shared/route'

const gateway = { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-cookrew' }

describe('routeEnv', () => {
  it('names the card in the session header the gateway counts by', () => {
    expect(routeSession('card-1')).toBe('cookrew:card-1')
    expect(sessionHeaderLine('card-1')).toBe('X-Magpie-Session: cookrew:card-1')
  })

  it('claude: base url, bearer, the model on every alias, the custom header; no args', () => {
    const r = routeEnv({ harness: 'claude', gateway, model: 'group/smart', cardId: 'card-1' })
    expect(r.routable).toBe(true)
    expect(r.args).toEqual([])
    expect(r.files).toEqual([])
    expect(r.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
      ANTHROPIC_AUTH_TOKEN: 'magpie-cookrew',
      ANTHROPIC_MODEL: 'group/smart',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'group/smart',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'group/smart',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'group/smart',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Magpie-Session: cookrew:card-1',
      // Without this claude 2.1.275 prints unrecognized_model and WAITS until killed (real gateway, round 2).
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1'
    })
    // Never an API key: ANTHROPIC_API_KEY asks claude for a one-time approval; the token does not.
    expect(r.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    // No context window named (a local model): the variable stays unset.
    expect(r.env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  })

  it("claude: the catalog's context window, when the model has one", () => {
    const r = routeEnv({ harness: 'claude', gateway, model: 'claude/claude-sonnet-5-5', cardId: 'card-1', contextWindow: 1000000 })
    expect(r.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
    expect(routeEnv({ harness: 'claude', gateway, model: 'ollama/qwen3', cardId: 'card-1', contextWindow: null }).env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  })

  it('codex: the provider table on the command line, the key through env_key', () => {
    const r = routeEnv({ harness: 'codex', gateway, model: 'deepseek/deepseek-chat', cardId: 'card-2' })
    expect(r.routable).toBe(true)
    expect(r.env).toEqual({ MAGPIE_GATEWAY_KEY: 'magpie-cookrew' })
    expect(r.args).toEqual([
      '-c', 'model_provider=magpie',
      '-c', 'model_providers.magpie.name=Magpie',
      '-c', 'model_providers.magpie.base_url=http://127.0.0.1:3425/v1',
      '-c', 'model_providers.magpie.env_key=MAGPIE_GATEWAY_KEY',
      '-c', 'model_providers.magpie.wire_api=responses',
      '-c', 'model_providers.magpie.http_headers={"X-Magpie-Session"="cookrew:card-2"}',
      '-c', 'model=deepseek/deepseek-chat'
    ])
  })

  it('opencode: one config file per card named by OPENCODE_CONFIG, the model scoped magpie/', () => {
    const r = routeEnv({ harness: 'opencode', gateway, model: 'group/smart', cardId: 'card-3' })
    expect(r.routable).toBe(true)
    expect(r.env.OPENCODE_CONFIG).toMatch(/\.cookrew\/route\/card-3\/opencode\.json$/)
    expect(r.args).toEqual(['--model', 'magpie/group/smart'])
    expect(r.files).toHaveLength(1)
    const config = JSON.parse(r.files[0].content) as {
      provider: { magpie: { npm: string; options: { baseURL: string; apiKey: string; headers: Record<string, string> }; models: Record<string, unknown> } }
      model: string
    }
    expect(config.provider.magpie.npm).toBe('@ai-sdk/openai-compatible')
    expect(config.provider.magpie.options.baseURL).toBe('http://127.0.0.1:3425/v1')
    expect(config.provider.magpie.options.apiKey).toBe('magpie-cookrew')
    expect(config.provider.magpie.options.headers).toEqual({ 'X-Magpie-Session': 'cookrew:card-3' })
    expect(Object.keys(config.provider.magpie.models)).toEqual(['group/smart'])
    expect(config.model).toBe('magpie/group/smart')
  })

  it('pi: a per-card agent dir with one models.json, sessions left where the binding looks, the provider on the line', () => {
    const r = routeEnv({ harness: 'pi', gateway, model: 'ollama/qwen2.5:1.5b', cardId: 'card-4' })
    expect(r.routable).toBe(true)
    expect(r.env.PI_CODING_AGENT_DIR).toMatch(/\.cookrew\/route\/card-4\/pi$/)
    expect(r.env.PI_CODING_AGENT_SESSION_DIR).toMatch(/\.pi\/agent\/sessions$/)
    expect(r.args).toEqual(['--provider', 'magpie', '--model', 'ollama/qwen2.5:1.5b'])
    expect(r.files).toHaveLength(1)
    expect(r.files[0].path).toBe(`${r.env.PI_CODING_AGENT_DIR}/models.json`)
    const models = JSON.parse(r.files[0].content) as { providers: { magpie: unknown } }
    expect(models.providers.magpie).toEqual({ baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-completions', apiKey: 'magpie-cookrew', headers: { 'X-Magpie-Session': 'cookrew:card-4' }, models: [{ id: 'ollama/qwen2.5:1.5b' }] })
  })

  it('the one shell quote leaves plain tokens alone and single-quotes the inline table', () => {
    expect(shellQuote('model_provider=magpie')).toBe('model_provider=magpie')
    expect(shellQuote('model_providers.magpie.base_url=http://127.0.0.1:3425/v1')).toBe('model_providers.magpie.base_url=http://127.0.0.1:3425/v1')
    expect(shellQuote('model_providers.magpie.http_headers={"X-Magpie-Session"="cookrew:c"}')).toBe(
      `'model_providers.magpie.http_headers={"X-Magpie-Session"="cookrew:c"}'`
    )
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})
