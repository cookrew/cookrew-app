import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
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
  /** What the owner called them — "Kestrel (Ana's instance)". Display only. */
  name?: string
  /**
   * When the owner revoked them. Set, never deleted.
   *
   * REVOKING DOES NOT DELETE HISTORY (Velvet's deck §6): the row moves to a
   * REVOKED section with its last-call time, because "who used to have access"
   * is a security question people ask after the fact. A hard delete answers it
   * with silence.
   *
   * It is also what makes the deck's 10-second UNDO exact rather than
   * approximate. Grants live on the EXPORT, and the gate AND-s enrolment with
   * the export's caller list — so revoking touches no grant at all, and undo is
   * clearing this field. The prior grant set comes back because it never left.
   */
  revokedAt?: number
  /** Last time this caller actually called, for the roster's LAST CALL column. */
  lastCallAt?: number
}

/** One exported agent. */
export interface AgentExport {
  workspaceId: string
  /** Terminal node id — the durable identity behind the address. */
  nodeId: string
  visibility: Visibility
  /**
   * Subjects entitled to call it. Empty means NOBODY, never everybody — see
   * the closed-default rule above, and isExport for why a call is never public
   * and so this list is never bypassed.
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
    c.jwk !== null &&
    (c.revokedAt === undefined || typeof c.revokedAt === 'number') &&
    (c.lastCallAt === undefined || typeof c.lastCallAt === 'number') &&
    (c.name === undefined || typeof c.name === 'string')
  )
}

/**
 * A LIVE CALL IS NEVER PUBLIC (S3).
 *
 * The shared gate has a `public` branch and the registry uses it: §9 is right
 * that "discovery and free download are not things identity should cost". A
 * CALL is neither of those. It is an anonymous stranger running compute on the
 * owner's machine, and — because §10 gives every conversation its own fork —
 * anonymity leaves nothing to key a conversation on, so anonymous callers would
 * have to share one transcript. Strangers reading each other's conversations is
 * a worse outcome than a branch this store never produces.
 *
 * So a public grant is refused when written and dropped when read. The gate's
 * public branch stays exercised where it belongs, on the download path. If
 * public calls are wanted later the safe shape is a server-minted,
 * unguessable conversation id handed back on the first call — a capability, not
 * an absence of one — and that is an addition rather than a change here.
 */
function isExport(value: unknown): value is AgentExport {
  const e = value as AgentExport
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.workspaceId === 'string' &&
    typeof e.nodeId === 'string' &&
    e.visibility === 'identified' &&
    Array.isArray(e.callers) &&
    e.callers.every((c) => typeof c === 'string')
  )
}

export class AgentExportStore {
  private readonly file: string
  /**
   * The parsed record, with the file identity it was parsed from.
   *
   * WHY THIS CACHE EXISTS (Tinker HIGH-2). Every unauthenticated call reached
   * this store BEFORE any credential was checked — deliberately, because
   * answering 404 before 401 is what stops a caller mapping the room — so an
   * anonymous flood meant a readFileSync plus a JSON.parse per request, twice
   * for a served one, on the Electron main thread. The fix is emphatically NOT
   * to check the credential first; it is to make the pre-credential work cheap.
   *
   * Keyed on mtime AND size rather than mtime alone: a same-millisecond
   * rewrite is exactly what an atomic replace produces, and a cache that missed
   * one would serve a withdrawn grant. Writes through this class update the
   * cache directly, so the stat is only paying for edits made behind its back.
   */
  private cache: { mtimeMs: number; size: number; value: ExportFile } | null = null

  constructor(base: string = path.join(homedir(), '.cookrew')) {
    this.file = path.join(base, 'exports.json')
  }

  /**
   * Read the record. A missing, unreadable or malformed file reads as EMPTY —
   * which grants nothing. Every failure mode of this function is a refusal.
   */
  private read(): ExportFile {
    let stamp: { mtimeMs: number; size: number }
    try {
      const stat = statSync(this.file)
      stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      // No file, or it cannot be stat'd. Either way there are no grants, and
      // the cache is dropped so a file appearing later is picked up.
      this.cache = null
      return EMPTY
    }
    const cached = this.cache
    if (cached !== null && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
      return cached.value
    }
    const value = this.parse()
    this.cache = { ...stamp, value }
    return value
  }

  private parse(): ExportFile {
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

  /**
   * Persist, at 0600.
   *
   * THE MODE IS NOT COSMETIC (Tinker MEDIUM-3). The integrity of this file IS
   * the gate: anyone who can write it enrols themselves and exports any agent.
   * The signing key was created 0600 and this was left at the platform default,
   * which was an asymmetry nobody chose — the two files are worth exactly the
   * same to an attacker. Set on every write, not only at creation, so a
   * restored backup or a `cp` cannot quietly loosen it.
   */
  private write(next: ExportFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomic(this.file, JSON.stringify(next, null, 2))
    chmodSync(this.file, 0o600)
    // Adopt what was just written rather than re-reading it on the next call.
    try {
      const stat = statSync(this.file)
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, value: next }
    } catch {
      this.cache = null
    }
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
    // A REVOKED caller is not enrolled. The record survives so the owner can see
    // who used to have access and can undo; it entitles nothing while it stands.
    return found && found.revokedAt === undefined ? found.jwk : null
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
      if (!same) return { ok: false, reason: 'caller_exists' }
      // Same key, and they are REVOKED: re-enrolling is the owner deliberately
      // letting them back in, which is `restore` — not a no-op that reports ok
      // while the caller stays locked out.
      if (existing.revokedAt !== undefined) {
        this.restore(workspaceId, sub)
      }
      return { ok: true }
    }
    this.write({ ...record, enrolled: [...record.enrolled, { workspaceId, sub, jwk }] })
    return { ok: true }
  }

  /**
   * Revoke a caller at one workspace. MARKED, not deleted — see `revokedAt`.
   *
   * Its outstanding credentials still expire on their own; what this guarantees
   * is that they stop entitling anyone immediately, because the gate reads
   * enrolment live at every call rather than trusting a minted token.
   */
  revoke(workspaceId: string, sub: string, at: number = Date.now()): void {
    const record = this.read()
    this.write({
      ...record,
      enrolled: record.enrolled.map((c) =>
        c.workspaceId === workspaceId && c.sub === sub && c.revokedAt === undefined
          ? { ...c, revokedAt: at }
          : c
      )
    })
  }

  /**
   * Undo a revoke, restoring EXACTLY the prior grant set.
   *
   * Exact by construction rather than by bookkeeping: revoking never touched a
   * grant, so there is no saved set to replay and nothing that can be replayed
   * wrongly. Returns false when there was nothing revoked to restore, so the
   * surface can tell "undone" from "the toast outlived the record".
   */
  restore(workspaceId: string, sub: string): boolean {
    const record = this.read()
    const found = record.enrolled.find(
      (c) => c.workspaceId === workspaceId && c.sub === sub && c.revokedAt !== undefined
    )
    if (!found) return false
    this.write({
      ...record,
      enrolled: record.enrolled.map((c) =>
        c === found ? { workspaceId: c.workspaceId, sub: c.sub, jwk: c.jwk,
                        ...(c.name !== undefined ? { name: c.name } : {}),
                        ...(c.lastCallAt !== undefined ? { lastCallAt: c.lastCallAt } : {}) } : c
      )
    })
    return true
  }

  /** Stamp a caller's last call, for the roster's LAST CALL column. */
  noteCall(workspaceId: string, sub: string, at: number = Date.now()): void {
    const record = this.read()
    const found = record.enrolled.find((c) => c.workspaceId === workspaceId && c.sub === sub)
    if (!found) return
    this.write({
      ...record,
      enrolled: record.enrolled.map((c) => (c === found ? { ...c, lastCallAt: at } : c))
    })
  }

  /** The export for a node, or null when it is not exported from this workspace. */
  exportOf(workspaceId: string, nodeId: string): AgentExport | null {
    return (
      this.read().exports.find((e) => e.workspaceId === workspaceId && e.nodeId === nodeId) ?? null
    )
  }

  /**
   * Export an agent, or replace its existing grant.
   *
   * Refuses a public grant rather than storing one that would be dropped on the
   * next read — a write that silently does nothing is how a surface ends up
   * believing an agent is exported when it is not.
   */
  exportAgent(grant: AgentExport): void {
    if (!isExport(grant)) {
      throw new Error('a live call is never public: export an agent to named callers')
    }
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

  /**
   * Every caller enrolled at a workspace. For the owner's own surfaces.
   *
   * Deliberately NOT the shape the gate uses. `enrolledKey` asks about one
   * subject at one workspace, because a gate that could enumerate is a gate
   * that can be asked "who is enrolled" by something that should not know.
   * This is the owner reading their own record, behind the owner-only IPC
   * check, and it is the only caller of it.
   */
  enrolledIn(workspaceId: string): EnrolledCaller[] {
    return this.read().enrolled.filter(
      (c) => c.workspaceId === workspaceId && c.revokedAt === undefined
    )
  }

  /** Callers the owner has revoked — the deck's REVOKED section. */
  revokedIn(workspaceId: string): EnrolledCaller[] {
    return this.read().enrolled.filter(
      (c) => c.workspaceId === workspaceId && c.revokedAt !== undefined
    )
  }
}
