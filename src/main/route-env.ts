import path from 'node:path'
import type { HarnessId } from './harness'
import { routeSession } from '../shared/route'

/**
 * THE ENVIRONMENT THAT POINTS A HARNESS AT THE GATEWAY (route program, D1b).
 *
 * One function, pure: given the harness, the gateway and the model a card
 * was given, the env and the extra args its process is spawned with — and,
 * for a harness that only takes a provider from a file, the file to write
 * first. Nothing here reads the disk or the network, so the exact lines
 * every harness receives are pinned by tests/route-env.test.ts and the two
 * that matter most were checked against the real binaries on 2026-10-11:
 *
 *   claude 2.1.275 sends `X-Magpie-Session` from ANTHROPIC_CUSTOM_HEADERS,
 *   `Authorization: Bearer <key>` from ANTHROPIC_AUTH_TOKEN and the model
 *   from ANTHROPIC_MODEL (a fake gateway recorded all three). It warns that
 *   a group id is "not in this version's model catalog" and sends anyway.
 *
 *   codex 0.162.1 takes the inline table on the command line exactly as
 *   written below — `-c 'model_providers.magpie.http_headers={"X-Magpie-
 *   Session"="cookrew:<id>"}'` — and the header, the bearer from env_key and
 *   the model all arrived; the exec round-tripped a Responses stream.
 *
 * The key is one for the whole app (`magpie-cookrew`, or what the plugin
 * file gave): on this machine the gateway takes any key and counts the
 * call under it; the card is told apart by the session header, which both
 * /v1/magpie/route?session= and /usage/requests?session= take.
 */

export interface RouteEnvInput {
  harness: HarnessId
  /** The gateway's address and the bearer — the key is main-only and arrives only here. */
  gateway: { url: string; v1: string; key: string }
  /** A Magpie model id or group id, never 'direct' (the caller decides that first). */
  model: string
  cardId: string
  /** The catalog's context_window for the model, when it has one; null for a local model. */
  contextWindow?: number | null
}

export interface RouteEnv {
  env: Record<string, string>
  /** Appended to the harness command. */
  args: string[]
  /** Written before the spawn, 0600, under ~/.cookrew/route/<cardId>/. */
  files: { path: string; content: string }[]
  /** False when this harness cannot be pointed at the gateway yet (pi, this round). */
  routable: boolean
}

export const SESSION_HEADER = 'X-Magpie-Session'
export const ROUTE_DIR = path.join(process.env.HOME ?? '', '.cookrew', 'route')
/** Which harnesses can be pointed at the gateway per process — all four, each proven with one real turn on 2026-10-11. */
export const ROUTABLE: Record<HarnessId, boolean> = { claude: true, codex: true, opencode: true, pi: true }

/** The header line claude takes: `Name: value`, one per line. */
export function sessionHeaderLine(cardId: string): string {
  return `${SESSION_HEADER}: ${routeSession(cardId)}`
}

export function routeEnv(input: RouteEnvInput): RouteEnv {
  const { harness, gateway, model, cardId } = input
  const session = routeSession(cardId)
  switch (harness) {
    case 'claude':
      return {
        env: {
          ANTHROPIC_BASE_URL: gateway.url,
          ANTHROPIC_AUTH_TOKEN: gateway.key,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          ANTHROPIC_CUSTOM_HEADERS: sessionHeaderLine(cardId),
          // Seen on the real gateway (round 2): with a model id outside its
          // catalog claude 2.1.275 prints `unrecognized_model` and then WAITS
          // until killed. This restores the previous wait-for-the-API path.
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
          // The window claude should assume: the catalog's, when it names one.
          ...(input.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(input.contextWindow) } : {})
        },
        args: [],
        files: [],
        routable: true
      }
    case 'codex':
      return {
        env: { MAGPIE_GATEWAY_KEY: gateway.key },
        args: [
          '-c', 'model_provider=magpie',
          '-c', 'model_providers.magpie.name=Magpie',
          '-c', `model_providers.magpie.base_url=${gateway.v1}`,
          '-c', 'model_providers.magpie.env_key=MAGPIE_GATEWAY_KEY',
          '-c', 'model_providers.magpie.wire_api=responses',
          '-c', `model_providers.magpie.http_headers={"${SESSION_HEADER}"="${session}"}`,
          '-c', `model=${model}`
        ],
        files: [],
        routable: true
      }
    case 'opencode': {
      // OPENCODE_CONFIG names one more config file (merged over the user's);
      // the provider entry is opencode's documented OpenAI-compatible shape.
      const file = path.join(ROUTE_DIR, cardId, 'opencode.json')
      const config = {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          magpie: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Magpie',
            options: { baseURL: gateway.v1, apiKey: gateway.key, headers: { [SESSION_HEADER]: session } },
            models: { [model]: { name: model } }
          }
        },
        model: `magpie/${model}`
      }
      return {
        env: { OPENCODE_CONFIG: file },
        args: ['--model', `magpie/${model}`],
        files: [{ path: file, content: `${JSON.stringify(config, null, 2)}\n` }],
        routable: true
      }
    }
    case 'pi': {
      // PI_CODING_AGENT_DIR moves pi's config directory per process, so a
      // per-card agent dir holding ONE models.json names the gateway as the
      // provider `magpie` without touching the user's ~/.pi/agent. Sessions
      // stay where Cookrew's pi binding looks (PI_CODING_AGENT_SESSION_DIR =
      // the default). Proven 2026-10-11: one real `pi -p` turn on Ollama
      // through magpie 0.1.1182 answered, with the route and the usage row
      // keyed by the session header. The user's extensions, skills and
      // auth.json in ~/.pi/agent are not loaded by a routed card (its dir is
      // its own) — the trade this round makes for not rewriting their file.
      const dir = path.join(ROUTE_DIR, cardId, 'pi')
      const models = {
        providers: {
          magpie: {
            baseUrl: gateway.v1,
            api: 'openai-completions',
            apiKey: gateway.key,
            headers: { [SESSION_HEADER]: session },
            models: [{ id: model }]
          }
        }
      }
      return {
        env: { PI_CODING_AGENT_DIR: dir, PI_CODING_AGENT_SESSION_DIR: path.join(process.env.HOME ?? '', '.pi', 'agent', 'sessions') },
        args: ['--provider', 'magpie', '--model', model],
        files: [{ path: path.join(dir, 'models.json'), content: `${JSON.stringify(models, null, 2)}\n` }],
        routable: true
      }
    }
  }
}

