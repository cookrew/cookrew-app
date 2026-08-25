// Where a REMOTE Sous lives, if there is one.
//
// Sous started as a local-only feature: Ollama on this machine, nothing leaving
// it. A hosted model is better at translation than anything that fits in a
// laptop's spare RAM, and pointing at one is a real trade — quality for the
// text leaving the machine — so it is opt-in by configuration and the UI says
// when it is on. Absent configuration, Sous is local exactly as before.
//
// THE KEY NEVER LIVES IN THE REPO. It comes from the environment, or from
// ~/.cookrew/sous.json which is outside the working tree and cannot be
// committed by accident.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RemoteSous {
  /** Base URL of an Anthropic-compatible /v1/messages endpoint. */
  baseUrl: string
  apiKey: string
  model: string
}

interface SousFile {
  translate?: { baseUrl?: string; apiKey?: string; model?: string }
}

/**
 * Where the config lives. Overridable because otherwise this function reads the
 * developer's home directory, which makes every test that touches Sous depend
 * on whether that particular machine happens to have a remote configured —
 * green here, red in CI, for reasons nothing in the test mentions.
 */
export function sousConfigPath(): string {
  return process.env.COOKREW_SOUS_CONFIG ?? join(homedir(), '.cookrew', 'sous.json')
}

/** The config file, or null when it is absent or unreadable. */
function fromFile(): SousFile['translate'] | null {
  try {
    const raw = readFileSync(sousConfigPath(), 'utf8')
    return (JSON.parse(raw) as SousFile).translate ?? null
  } catch {
    // Absent is the normal case, not an error: most machines run local Sous.
    return null
  }
}

let cached: RemoteSous | null | undefined

/**
 * The remote translator, or null for "use the local one".
 *
 * Requires BOTH a URL and a key. A URL without a key would be sent unauthorized
 * and fail on every click; treating half a configuration as configured turns a
 * typo into a feature that is broken rather than a feature that is local.
 */
export function remoteSous(): RemoteSous | null {
  if (cached !== undefined) return cached
  const file = fromFile()
  const baseUrl = (process.env.COOKREW_SOUS_TRANSLATE_URL ?? file?.baseUrl ?? '').trim()
  const apiKey = (process.env.COOKREW_SOUS_TRANSLATE_KEY ?? file?.apiKey ?? '').trim()
  const model = (process.env.COOKREW_SOUS_TRANSLATE_MODEL ?? file?.model ?? '').trim()
  cached =
    baseUrl.length > 0 && apiKey.length > 0 && model.length > 0
      ? { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
      : null
  return cached
}

/** Host only — for telling the reader where their text is going. Never the key. */
export function remoteSousHost(): string | null {
  const remote = remoteSous()
  if (!remote) return null
  try {
    return new URL(remote.baseUrl).host
  } catch {
    return remote.baseUrl
  }
}

/** Tests only: forget the memoised configuration. */
export function resetRemoteSousCache(): void {
  cached = undefined
}
