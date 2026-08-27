import { MKT_GATE } from '../shared/marketplace-copy'

export interface CrewLineTarget {
  origin: string
  slug: string
}

function validTarget(origin: string, slug: string): CrewLineTarget | null {
  try {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
    return { origin: url.origin, slug }
  } catch {
    return null
  }
}

/** Parse only the JSON-quoted argv format emitted by crewLineCommand. */
function commandArgs(command: string): string[] | null {
  if (!command.startsWith('node ')) return null
  const args: string[] = []
  let at = 5
  while (at < command.length) {
    while (command[at] === ' ') at += 1
    if (at >= command.length) break
    if (command[at] !== '"') return null
    let end = at + 1
    let escaped = false
    for (; end < command.length; end += 1) {
      const char = command[end]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    if (end >= command.length) return null
    try {
      const value: unknown = JSON.parse(command.slice(at, end + 1))
      if (typeof value !== 'string') return null
      args.push(value)
    } catch {
      return null
    }
    at = end + 1
    if (at < command.length && command[at] !== ' ') return null
  }
  return args
}

export interface ParsedCrewLineCommand {
  script: string
  target: CrewLineTarget
}

/**
 * Load-time migration for cards placed before the explicit transcript source
 * existed. This recognizes only our own builder's exact argv encoding.
 */
export function parseCrewLineCommand(command: string): ParsedCrewLineCommand | null {
  const args = commandArgs(command)
  if (!args || !/[\\/]crew-line\.mjs$/.test(args[0] ?? '')) return null
  const originAt = args.indexOf('--origin')
  const slugAt = args.indexOf('--slug')
  if (originAt < 0 || slugAt < 0) return null
  const target = validTarget(args[originAt + 1] ?? '', args[slugAt + 1] ?? '')
  return target ? { script: args[0], target } : null
}

/**
 * Build the placed card's command. Payment references are deliberately absent:
 * crew-line may send X-Payment only after its caller types `/pay` in that live
 * process, never from a persisted chip value left over from an earlier quote.
 */
export function crewLineCommand(script: string, crew: CrewLineTarget): string {
  const args = [
    script,
    '--origin',
    crew.origin,
    '--slug',
    crew.slug,
    '--payment-unavailable-copy',
    MKT_GATE['mkt.gate.payment.unavailable'],
    '--payment-unverifiable-copy',
    MKT_GATE['mkt.gate.payment.unverifiable']
  ]
  return `node ${args.map((value) => JSON.stringify(value)).join(' ')}`
}
