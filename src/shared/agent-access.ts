/**
 * HOW AN AGENT REACHES A MODEL, WHEN NOT THROUGH THE PERSON'S OWN CLAUDE OR CODEX
 * SIGN-IN. A source is an address, a protocol, a model and a key held apart; the
 * launch (main/agent-access.ts) knows nothing else. Today the one source is the
 * person's own endpoint. "Use Cookrew credits" is one more row in ACCESS_ROWS and
 * a source whose address and key come from the account: no field here changes.
 */

export type AccessProtocol = 'anthropic' | 'openai'

export interface AccessSource {
  readonly id: string
  readonly label: string
  readonly protocol: AccessProtocol
  readonly baseUrl: string
  readonly model: string
  /** For an OpenAI-style source: what the address answered. Codex needs the Responses API. */
  readonly wire?: AccessWire
}

export type AccessWire = 'responses' | 'chat'

/** One way in, as the tool check lists it. `form` says what the row opens. */
export interface AccessRow {
  readonly id: string
  readonly title: string
  readonly does: string
  readonly form: 'endpoint'
}

export const ENDPOINT_ID = 'endpoint'

export const ACCESS_ROWS: readonly AccessRow[] = [
  { id: ENDPOINT_ID, title: 'Use your own endpoint', does: 'Any service that speaks the Anthropic or OpenAI API. You bring the address, key and model.', form: 'endpoint' }
]

/** What a screen may know: never the key. */
export interface AccessState {
  readonly rows: readonly AccessRow[]
  readonly active: { readonly id: string; readonly label: string; readonly protocol: AccessProtocol; readonly model: string; readonly host: string; readonly tools: readonly string[] } | null
}

export interface EndpointInput {
  readonly protocol: AccessProtocol
  readonly baseUrl: string
  readonly key: string
  readonly model: string
}

export type EndpointField = 'protocol' | 'baseUrl' | 'key' | 'model'

export type EndpointCheck = { readonly ok: true; readonly value: EndpointInput } | { readonly ok: false; readonly field: EndpointField; readonly why: string }

/** The tools that can run on a source, as presets, the first agent's pick first. */
export function accessTools(source: { readonly protocol: AccessProtocol; readonly wire?: AccessWire }): readonly string[] {
  if (source.protocol === 'anthropic') return ['Claude Code', 'Pi']
  return source.wire === 'chat' ? ['Pi'] : ['Codex', 'Pi']
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/
const KEY_RE = /^[\x21-\x7e]{1,4096}$/

const refuse = (field: EndpointField, why: string): EndpointCheck => ({ ok: false, field, why })

/** What the harness will extend: Claude Code adds /v1/messages, Codex adds /responses to what it is given. */
function normalised(url: URL, protocol: AccessProtocol): string {
  const trimmed = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  return protocol === 'anthropic' ? trimmed.replace(/\/v1$/, '') : trimmed
}

/** The form, checked: it arrives over a bridge, so every field is doubted. Nothing here touches the network. */
export function checkEndpoint(input: unknown): EndpointCheck {
  const form = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const { protocol, baseUrl, key, model } = form
  if (protocol !== 'anthropic' && protocol !== 'openai') return refuse('protocol', 'Choose which API it speaks.')
  let url: URL
  try {
    url = new URL(String(baseUrl ?? '').trim())
  } catch {
    return refuse('baseUrl', 'That is not a web address.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return refuse('baseUrl', 'Use an https address. Plain http is only for a server on this computer, or your key would cross the network unprotected.')
  }
  if (url.username || url.password) return refuse('baseUrl', 'Put the key in its own field, not in the address.')
  if (url.search || url.hash) return refuse('baseUrl', 'The address cannot hold a ? or a #.')
  const secret = typeof key === 'string' ? key.trim() : ''
  if (!KEY_RE.test(secret)) return refuse('key', 'Paste the key, with no spaces.')
  const name = typeof model === 'string' ? model.trim() : ''
  if (!MODEL_RE.test(name)) return refuse('model', 'Type the model’s id, as the service names it.')
  return { ok: true, value: { protocol, baseUrl: normalised(url, protocol), key: secret, model: name } }
}
