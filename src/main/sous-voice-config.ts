// What the owner has told Sous about how they say things.
//
//   ~/.cookrew/sous.json
//   {
//     "voice": { "locale": "zh-CN" },
//     "aliases": { "Conductor": ["<the owner's word for it>", "<a phonetic spelling>"] }
//   }
//
// Aliases exist because an on-device zh-CN recognizer turns "Conductor" into
// unrelated syllables with or without hints (measured, P0 spike) — the owner's own words
// for an agent are the only reliable way a Chinese sentence names it. Read per
// call, never cached: the file is edited by hand and a restart to see it is a
// surprise.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export interface SousVoiceConfig {
  locale: string
  aliases: Readonly<Record<string, readonly string[]>>
}

export const DEFAULT_VOICE_LOCALE = 'zh-CN'

export function sousConfigPath(base: string = path.join(homedir(), '.cookrew')): string {
  return path.join(base, 'sous.json')
}

/** A file that cannot be read is an empty config, said once on stderr. */
export function readSousVoiceConfig(file: string = sousConfigPath()): SousVoiceConfig {
  const empty: SousVoiceConfig = { locale: DEFAULT_VOICE_LOCALE, aliases: {} }
  if (!existsSync(file)) return empty
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      voice?: { locale?: unknown }
      aliases?: unknown
    }
    return {
      locale: typeof raw.voice?.locale === 'string' ? raw.voice.locale : DEFAULT_VOICE_LOCALE,
      aliases: readAliases(raw.aliases)
    }
  } catch (error) {
    console.error(`Sous: ${file} is not readable, using defaults:`, error)
    return empty
  }
}

function readAliases(raw: unknown): Record<string, readonly string[]> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, readonly string[]> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const words = value.filter((w): w is string => typeof w === 'string' && w.trim() !== '')
    if (words.length > 0) out[name] = words
  }
  return out
}
