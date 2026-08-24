// IMPORT A TEMPLATE AS A SESSION — the caller's side of R30.
//
// A template is a preset with one door (teams.ts entryAgentOf). Importing it
// does NOT paste the whole team onto your canvas; it opens a session you talk
// to through the orchestrator. The caller's workspace gets exactly ONE terminal
// — the entry orch — and that terminal's input/output rides an HTTP call to the
// served orchestrator, which runs the rest of the team on the owner's side.
//
// This module is the PURE PLAN: given a template and where it is served, it
// says what workspace and what single terminal to create, and the command that
// terminal runs to reach the orch. The wiring (create workspace, place node)
// lives in index.ts; the interactive HTTP harness that command names is the
// remote-teammate-card (call-client.ts). Kept pure so the plan is testable
// against a fixture with no app, no network, no pty.

import type { CanvasNode, TerminalNodeData } from '../shared/model'
import { entryAgentOf, type TeamSnapshot } from './teams'

/** Where a template is served — the origin and workspace slug of the owner. */
export interface ServeTarget {
  /** The owner's listener origin, e.g. https://drej.cookrew.dev */
  origin: string
  /** The owner's workspace slug the service is mounted under. */
  slug: string
}

/** What importing a template produces. */
export interface ImportPlan {
  /** The caller's new session workspace name. */
  workspaceName: string
  /** The single terminal to place — the entry orchestrator, over HTTP. */
  orch: {
    name: string
    /** The command the terminal runs: an HTTP call to the entry orch's ask. */
    command: string
    /** The ask endpoint, so a harness reads it without re-parsing the command. */
    askUrl: string
  }
}

/**
 * The address a caller reaches the entry orch at. One mount, the same one a
 * phone uses on LAN: /<slug>/agents/<name>/ask, now over the public origin.
 */
export function orchAskUrl(target: ServeTarget, orch: string): string {
  const origin = target.origin.replace(/\/+$/, '')
  return `${origin}/${target.slug}/agents/${encodeURIComponent(orch)}/ask`
}

/**
 * Plan the import. Throws only on a template with no agent to enter — a
 * template you cannot enter is not importable, and that must fail loudly rather
 * than produce an empty session.
 */
export function planImportSession(snapshot: TeamSnapshot, target: ServeTarget): ImportPlan {
  const orch = entryAgentOf(snapshot)
  if (!orch) {
    throw new Error(`Template '${snapshot.name}' has no agent to enter — cannot import`)
  }
  const askUrl = orchAskUrl(target, orch)
  return {
    // A session, not a copy: named so the caller sees whose crew and that it is
    // live, never confused with a local template.
    workspaceName: `${snapshot.name} · session`,
    orch: {
      name: orch,
      // The fixture-backed seam: `cookrew call <url>` is the interactive client
      // (call-client.ts) that does the 401/402 ceremony then streams the ask.
      // The command carries the address so the harness needs no side channel.
      command: `cookrew call ${askUrl}`,
      askUrl
    }
  }
}

/**
 * The terminal node the plan places. A normal terminal card — same idiom the
 * caller already knows — whose backend happens to be a remote orch. `orch` is
 * true because to the caller this IS the orchestrator; `role` names it so the
 * card reads as the crew, not a bare shell.
 */
export function orchTerminalNode(
  plan: ImportPlan,
  id: string,
  cwd: string,
  position: CanvasNode['position']
): TerminalNodeData {
  return {
    kind: 'terminal',
    id,
    name: plan.orch.name,
    preset: 'Remote',
    command: plan.orch.command,
    cwd,
    orch: true,
    role: null,
    position,
    size: { width: 420, height: 300 }
  }
}
