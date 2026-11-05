import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import type { HarnessId } from './harness'
import type { SecretsStore } from './secrets-store'
import { shellQuote } from './shell-quote'
import { ACCESS_ROWS, ENDPOINT_ID, accessTools, type AccessSource, type AccessState, type AccessWire, type EndpointField, type EndpointInput } from '../shared/agent-access'

/**
 * THE ROAD FOR A PERSON WITH NO CLAUDE OR CODEX ACCOUNT. Which source is on, the
 * launch it makes, and the one question asked of an endpoint before it is saved.
 *
 * THE KEY IS IN NO COMMAND LINE AND NO PROCESS'S ENVIRONMENT. Route env reaches a
 * pane on tmux's argv and herdr's `--env`, which `ps` shows to every user of a
 * shared box. And environment is no hiding place: from inside a served seat's
 * Seatbelt profile, KERN_PROCARGS2 read another process's environment, and no
 * rule stopped it (measured 2026-11-05, Darwin 25.5, on a canary). So it is sealed
 * in the secrets store with a 0600 copy in a folder the seat is denied
 * (owner-secrets.ts), and each harness reads that file itself: Claude Code's
 * `apiKeyHelper`, Codex's provider `auth` command, Pi's `!command` key. Only the
 * path ever appears. With COOKREW_SECRETS_KEYCHAIN=1 that copy is the one value
 * outside the keychain. The screens get `state()`, which has no key in it.
 *
 * SHAPE, proved against a loopback fake on 2026-11-05 with claude 2.1.316, codex
 * 0.166 and pi 1.4: each sent Bearer <key> to the path probeEndpoint asks, claude
 * skipped its login menu, and a full interactive claude turn completed. Codex
 * refuses `wire_api=chat` outright, so a chat-only OpenAI-style server runs on Pi.
 */

const PROVIDER = 'cookrew'
const PROBE_BUDGET_MS = 10_000

export const secretNameOf = (sourceId: string): string => `agent-access-${sourceId}`

export interface AccessLaunch {
  env: Record<string, string>
  args: string[]
  /** Written before the spawn, 0600. None holds the key. */
  files: { path: string; content: string }[]
}

export interface AccessPaths {
  keyFile: string
  piDir: string
}

/** What a harness is started with for a source; null when it does not speak it. */
export function accessLaunch(source: AccessSource, harness: HarnessId | undefined, { keyFile, piDir }: AccessPaths): AccessLaunch | null {
  const { baseUrl, model, protocol } = source
  const readKey = `/bin/cat ${shellQuote(keyFile)}`
  if (harness === 'pi') {
    const provider = { baseUrl, api: protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions', apiKey: `!${readKey}`, models: [{ id: model }] }
    return {
      env: { PI_CODING_AGENT_DIR: piDir, PI_CODING_AGENT_SESSION_DIR: path.join(homedir(), '.pi', 'agent', 'sessions') },
      args: ['--provider', PROVIDER, '--model', model],
      files: [{ path: path.join(piDir, 'models.json'), content: `${JSON.stringify({ providers: { [PROVIDER]: provider } }, null, 2)}\n` }]
    }
  }
  if (protocol === 'anthropic' && harness === 'claude') {
    return {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        // Without it claude waits for ever on a model outside its catalog (route-env.ts).
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1'
      },
      args: ['--settings', JSON.stringify({ apiKeyHelper: readKey })],
      files: []
    }
  }
  if (protocol === 'openai' && harness === 'codex' && source.wire !== 'chat') {
    return {
      env: {},
      args: [
        '-c', `model_provider=${PROVIDER}`,
        '-c', `model_providers.${PROVIDER}.name=${source.label}`,
        '-c', `model_providers.${PROVIDER}.base_url=${baseUrl}`,
        '-c', `model_providers.${PROVIDER}.auth={command="/bin/cat",args=[${JSON.stringify(keyFile)}]}`,
        '-c', `model_providers.${PROVIDER}.wire_api=responses`,
        '-c', `model=${model}`
      ],
      files: []
    }
  }
  return null
}

export interface AccessStoreDeps {
  /** The source, without its key. */
  file: string
  /** Where a source's key waits for a pane. Denied to a served seat (owner-secrets.ts). */
  keyDir: string
  secrets: Pick<SecretsStore, 'put' | 'read' | 'remove'>
}

function readSource(file: string): AccessSource | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccessSource>
    const { id, label, protocol, baseUrl, model, wire } = saved
    if (typeof id !== 'string' || typeof label !== 'string' || typeof baseUrl !== 'string' || typeof model !== 'string') return null
    return protocol === 'anthropic' || protocol === 'openai' ? { id, label, protocol, baseUrl, model, ...(wire === 'chat' || wire === 'responses' ? { wire } : {}) } : null
  } catch {
    return null
  }
}

export class AccessStore {
  private source: AccessSource | null

  constructor(private readonly deps: AccessStoreDeps) {
    this.source = readSource(deps.file)
  }

  active(): AccessSource | null {
    return this.source
  }

  state(): AccessState {
    const { source } = this
    return {
      rows: ACCESS_ROWS,
      active: source && { id: source.id, label: source.label, protocol: source.protocol, model: source.model, host: new URL(source.baseUrl).host, tools: accessTools(source) }
    }
  }

  save(source: AccessSource, key: string): void {
    this.deps.secrets.put(secretNameOf(source.id), key)
    writeFileAtomic(this.deps.file, `${JSON.stringify(source)}\n`)
    this.source = source
  }

  private keyFile(sourceId: string): string {
    return path.join(this.deps.keyDir, `${sourceId}.key`)
  }

  clear(): void {
    if (this.source) this.deps.secrets.remove(secretNameOf(this.source.id))
    rmSync(this.deps.file, { force: true })
    rmSync(this.deps.keyDir, { recursive: true, force: true })
    this.source = null
  }

  /** The launch for a harness, its key put out for it to read; null when no source applies. */
  launchFor(harness: HarnessId | undefined): AccessLaunch | null {
    const { source } = this
    if (source === null) return null
    const keyFile = this.keyFile(source.id)
    const launch = accessLaunch(source, harness, { keyFile, piDir: path.join(this.deps.keyDir, 'pi') })
    if (launch === null) return null
    const key = this.deps.secrets.read(secretNameOf(source.id))?.value
    // The secret was removed by name, elsewhere: its copy goes with it.
    if (!key) {
      rmSync(keyFile, { force: true })
      return null
    }
    mkdirSync(this.deps.keyDir, { recursive: true, mode: 0o700 })
    writeFileAtomic(keyFile, key)
    for (const file of launch.files) writeFileAtomic(file.path, file.content)
    return launch
  }
}

export const endpointSource = (input: EndpointInput, wire?: AccessWire): AccessSource => ({
  id: ENDPOINT_ID,
  label: 'Your endpoint',
  protocol: input.protocol,
  baseUrl: input.baseUrl,
  model: input.model,
  ...(wire ? { wire } : {})
})

export type ProbeAnswer = { ok: true; wire?: AccessWire } | { ok: false; field: EndpointField; why: string }

/**
 * One small request, to the path and with the bearer the harness will use. Only
 * the status is read: what a server sends back never reaches a screen. A redirect
 * is refused, so the key cannot follow it to another host.
 */
export async function probeEndpoint(input: EndpointInput, fetchFn: typeof fetch = fetch): Promise<ProbeAnswer> {
  const ask = async (route: string, body: unknown): Promise<number | null> => {
    try {
      const res = await fetchFn(`${input.baseUrl}${route}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_BUDGET_MS),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.key}`, ...(input.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) },
        body: JSON.stringify(body)
      })
      return res.status
    } catch {
      return null
    }
  }
  const { model } = input
  if (input.protocol === 'anthropic') return verdict(await ask('/v1/messages', { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }), 'Nothing answered at that address. It should be the part before /v1/messages.')
  const responses = await ask('/responses', { model, input: 'ping', max_output_tokens: 16 })
  if (responses !== 404) return withWire(verdict(responses, ''), 'responses')
  // Most OpenAI-compatible servers stop here, and Pi needs no more than this.
  const chat = await ask('/chat/completions', { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
  return withWire(verdict(chat, 'Nothing answered there. The address should be the part before /chat/completions, usually ending in /v1.'), 'chat')
}

const withWire = (answer: ProbeAnswer, wire: AccessWire): ProbeAnswer => (answer.ok ? { ok: true, wire } : answer)

/** What a status says. A rate limit or a picky body still proves the address and the key got through. */
function verdict(status: number | null, notFound: string): ProbeAnswer {
  if (status === null) return { ok: false, field: 'baseUrl', why: 'Nothing answered at that address. Check it, and that this computer can reach it.' }
  if (status === 401 || status === 403) return { ok: false, field: 'key', why: 'The endpoint refused that key.' }
  if (status === 404) return { ok: false, field: 'baseUrl', why: notFound }
  if ((status >= 200 && status < 300) || status === 400 || status === 422 || status === 429) return { ok: true }
  return { ok: false, field: 'baseUrl', why: `The endpoint answered ${status}. Try again in a moment, or check the address.` }
}
