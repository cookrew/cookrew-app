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

import type { CanvasNode, TerminalNodeData } from '../shared/model'

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
 * The placed card's command: JSON-quoted argv, no shell (a pane may exec argv
 * without one), no payment state (a reference is supplied interactively in the
 * live line, never persisted into node data).
 */
export function orchLineCommand(script: string, target: ServeTarget, name: string): string {
  const args = [script, '--origin', target.origin, '--slug', target.slug, '--name', name]
  return `node ${args.map((value) => JSON.stringify(value)).join(' ')}`
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
  position: CanvasNode['position']
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
    position,
    size: { width: 420, height: 300 }
  }
}
