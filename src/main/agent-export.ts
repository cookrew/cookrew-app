import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './turn-annotations'
import type { Visibility } from '../shared/gate'

/**
 * WHO MAY CALL WHAT (§9, ④ · S2) — the owner's grant record.
 *
 * An exported agent is a teammate over the internet, and this file is the only
 * thing that makes one exist. Every default here is the closed one: an agent
 * nobody exported is not callable, a caller nobody enrolled cannot obtain a
 * credential, and an export with no callers listed entitles NOBODY rather than
 * everybody. There is no value meaning "open" that a corrupt file, a failed
 * parse or a forgotten field can produce by accident.
 *
 * TWO SEPARATE GRANTS, deliberately. Enrolment says who may hold a credential
 * for a WORKSPACE; an export says who may call one AGENT in it. Collapsing them
 * would mean enrolling a caller to reach one agent handed them every agent in
 * the workspace, and the whole point of a marketplace is that the owner exports
 * one teammate without opening the room it works in.
 *
 * AN EXPORT NAMES A NODE, NOT A LABEL. The address is the agent's NAME
 * (/<slug>/agents/<name>/ask), but the grant is keyed by terminal id — the
 * identity that is stable across restarts and keys everything else in this
 * codebase. Renaming an agent therefore changes its address and keeps its
 * grant, rather than silently revoking a buyer's access because the owner
 * tidied a card title.
 */

/** A caller enrolled at one workspace: its subject and the key it signs with. */
export interface EnrolledCaller {
  workspaceId: string
  /** Stable caller id. Becomes `sub` in every credential minted for it. */
  sub: string
  /** ed25519 public key as a JWK. Verified against, never signed with. */
  jwk: Record<string, unknown>
}

/** One exported agent. */
export interface AgentExport {
  workspaceId: string
  /** Terminal node id — the durable identity behind the address. */
  nodeId: string
  visibility: Visibility
  /**
   * Subjects entitled to call it. Empty means NOBODY, never everybody — see
   * the closed-default rule above. Ignored when visibility is 'public', which
   * is the owner saying out loud that identity is not required here.
   */
  callers: readonly string[]
}

interface ExportFile {
  enrolled: EnrolledCaller[]
  exports: AgentExport[]
}

const EMPTY: ExportFile = { enrolled: [], exports: [] }

function isEnrolled(value: unknown): value is EnrolledCaller {
  const c = value as EnrolledCaller
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.workspaceId === 'string' &&
    typeof c.sub === 'string' &&
    c.sub.length > 0 &&
    typeof c.jwk === 'object' &&
    c.jwk !== null
  )
}

function isExport(value: unknown): value is AgentExport {
  const e = value as AgentExport
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.workspaceId === 'string' &&
    typeof e.nodeId === 'string' &&
    (e.visibility === 'public' || e.visibility === 'identified') &&
    Array.isArray(e.callers) &&
    e.callers.every((c) => typeof c === 'string')
  )
}

export class AgentExportStore {
  private readonly file: string

  constructor(base: string = path.join(homedir(), '.cookrew')) {
    this.file = path.join(base, 'exports.json')
  }

  /**
   * Read the record. A missing, unreadable or malformed file reads as EMPTY —
   * which grants nothing. Every failure mode of this function is a refusal.
   */
  private read(): ExportFile {
    if (!existsSync(this.file)) return EMPTY
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ExportFile
      return {
        // A record that does not parse as a grant is not a grant. Dropped
        // individually so one corrupt entry cannot open or close the rest.
        enrolled: Array.isArray(parsed?.enrolled) ? parsed.enrolled.filter(isEnrolled) : [],
        exports: Array.isArray(parsed?.exports) ? parsed.exports.filter(isExport) : []
      }
    } catch {
      return EMPTY
    }
  }

  private write(next: ExportFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomic(this.file, JSON.stringify(next, null, 2))
  }

  /**
   * The key a caller is enrolled with at this workspace, or null.
   *
   * Scoped by workspace in the lookup itself, so there is no way to ask "is
   * this caller enrolled anywhere" and accidentally accept the answer.
   */
  enrolledKey(workspaceId: string, sub: string): Record<string, unknown> | null {
    const found = this.read().enrolled.find(
      (c) => c.workspaceId === workspaceId && c.sub === sub
    )
    return found ? found.jwk : null
  }

  /**
   * Enrol a caller at one workspace. TOFU, the same rule as the registry's
   * author keys: a subject already known at this workspace cannot be
   * re-registered under a DIFFERENT key, so reaching this function is not
   * enough to take over an existing caller's identity.
   */
  enrol(
    workspaceId: string,
    sub: string,
    jwk: Record<string, unknown>
  ): { ok: boolean; reason?: string } {
    if (sub.length === 0 || workspaceId.length === 0) {
      return { ok: false, reason: 'incomplete' }
    }
    const record = this.read()
    const existing = record.enrolled.find((c) => c.workspaceId === workspaceId && c.sub === sub)
    if (existing) {
      const same = JSON.stringify(existing.jwk) === JSON.stringify(jwk)
      return same ? { ok: true } : { ok: false, reason: 'caller_exists' }
    }
    this.write({ ...record, enrolled: [...record.enrolled, { workspaceId, sub, jwk }] })
    return { ok: true }
  }

  /** Forget a caller at one workspace. Its outstanding credentials still expire. */
  revoke(workspaceId: string, sub: string): void {
    const record = this.read()
    this.write({
      ...record,
      enrolled: record.enrolled.filter(
        (c) => !(c.workspaceId === workspaceId && c.sub === sub)
      )
    })
  }

  /** The export for a node, or null when it is not exported from this workspace. */
  exportOf(workspaceId: string, nodeId: string): AgentExport | null {
    return (
      this.read().exports.find((e) => e.workspaceId === workspaceId && e.nodeId === nodeId) ?? null
    )
  }

  /** Export an agent, or replace its existing grant. */
  exportAgent(grant: AgentExport): void {
    const record = this.read()
    this.write({
      ...record,
      exports: [
        ...record.exports.filter(
          (e) => !(e.workspaceId === grant.workspaceId && e.nodeId === grant.nodeId)
        ),
        { ...grant, callers: [...grant.callers] }
      ]
    })
  }

  /** Withdraw an export. The agent stops being addressable immediately. */
  unexport(workspaceId: string, nodeId: string): void {
    const record = this.read()
    this.write({
      ...record,
      exports: record.exports.filter(
        (e) => !(e.workspaceId === workspaceId && e.nodeId === nodeId)
      )
    })
  }

  /** Every export in a workspace. For the owner's own surfaces, not the gate. */
  exportsIn(workspaceId: string): AgentExport[] {
    return this.read().exports.filter((e) => e.workspaceId === workspaceId)
  }
}
