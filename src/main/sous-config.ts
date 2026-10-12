import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
// Where Sous lives and what it runs. Shared by every Sous caller so a machine
// with a non-default Ollama is configured once, not once per feature.
//
//   COOKREW_SOUS=0            disable entirely
//   COOKREW_SOUS_URL          Ollama base URL (default http://127.0.0.1:11434)
//   COOKREW_SOUS_MODEL        model name       (default qwen2.5:1.5b)
//   COOKREW_SOUS_TRANSLATE_MODEL  model for translation (default: the above)

export const SOUS_BASE_URL = process.env.COOKREW_SOUS_URL ?? 'http://127.0.0.1:11434'
export const SOUS_MODEL = process.env.COOKREW_SOUS_MODEL ?? 'qwen2.5:1.5b'
export const SOUS_DISABLED = process.env.COOKREW_SOUS === '0'

/**
 * The model used for TRANSLATION, which defaults to the titling model.
 *
 * Titling and translating are not equally hard. A 1.5b model writes a decent
 * six-word title and a passable translation — passable meaning it occasionally
 * narrates a line or flattens a heading. Defaulting to a bigger model would be
 * better output and a worse default: the titling model is the one we know is
 * pulled, and a default nobody has pulled fails on first click. So the default
 * is the model that works, and this is how you ask for the model that is good.
 */
export const SOUS_TRANSLATE_MODEL =
  process.env.COOKREW_SOUS_TRANSLATE_MODEL ?? process.env.COOKREW_SOUS_MODEL ?? 'qwen2.5:1.5b'

/**
 * The model that cleans up dictation (shared/sous-polish). Defaults to the
 * titling model for the same reason translation does: it is the one that is
 * known to be pulled. A bigger resident model (COOKREW_SOUS_POLISH_MODEL)
 * does noticeably better at self-corrections in Chinese.
 */
export const SOUS_POLISH_MODEL =
  process.env.COOKREW_SOUS_POLISH_MODEL ?? process.env.COOKREW_SOUS_MODEL ?? 'qwen2.5:1.5b'

/**
 * How long Ollama keeps the model resident. Default 5m so a ~1.25GB model does
 * not sit in memory all day for occasional work.
 */
export const SOUS_KEEP_ALIVE = process.env.COOKREW_SOUS_KEEPALIVE ?? '5m'

/**
 * THE SCOPED GATEWAY KEY SOUS SPEAKS WITH (HP round, audit §11).
 *
 * scripts/magpie-sous-key.sh mints a Magpie gateway key limited to the
 * groups Sous may route to and stores it at ~/.cookrew/sous-gateway.key
 * (0600, in the served deny list). When the file is there its contents are
 * the bearer; otherwise the local `magpie-sous` token, exactly as before.
 * Read per call, so a rotation needs no restart; never logged.
 */
export const SOUS_GATEWAY_KEY_FILE = 'sous-gateway.key'
export const SOUS_GATEWAY_KEY_FALLBACK = 'magpie-sous'

/**
 * THE SOUS PLUGIN FILE — ~/.cookrew/sous-magpie.json, written by Magpie's
 * own Agents page through resources/magpie-sous (design §12 J4): the
 * gateway, its /v1, the key Sous speaks with, and the model it decides
 * with. Read PER CALL, never cached and never watched, and null when the
 * file is absent or not yet complete — so until the owner installs the
 * plugin and picks a model, nothing about Sous changes. No call site reads
 * the route yet (E2E round, lane plugin); the key already feeds
 * sousGatewayKey() below.
 */
export const SOUS_ROUTE_FILE = 'sous-magpie.json'

export interface SousRouteConfig {
  readonly gateway: string
  readonly v1: string
  readonly key: string
  readonly model: string
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export const sousRouteConfig = (base: string = path.join(homedir(), '.cookrew')): SousRouteConfig | null => {
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(path.join(base, SOUS_ROUTE_FILE), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const gateway = raw['route.gateway']
  const v1 = raw['route.v1']
  const key = raw['route.key']
  const model = raw['route.model']
  if (!nonEmpty(gateway) || !nonEmpty(v1) || !nonEmpty(key) || !nonEmpty(model)) return null
  return { gateway: gateway.trim(), v1: v1.trim(), key: key.trim(), model: model.trim() }
}

/**
 * The key Sous speaks with, in order: the plugin file's `route.key` (the
 * owner picked it on Magpie's page), then the scoped key the script minted
 * (~/.cookrew/sous-gateway.key), then the local `magpie-sous` token.
 */
export const sousGatewayKey = (base: string = path.join(homedir(), '.cookrew')): string => {
  const route = sousRouteConfig(base)
  if (route) return route.key
  try {
    const key = readFileSync(path.join(base, SOUS_GATEWAY_KEY_FILE), 'utf8').trim()
    return key.length > 0 ? key : SOUS_GATEWAY_KEY_FALLBACK
  } catch {
    return SOUS_GATEWAY_KEY_FALLBACK
  }
}
