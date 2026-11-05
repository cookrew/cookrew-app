// Durable global agent directory: ~/.cookrew/agents.json records every agent
// terminal ever spawned, across ALL workspaces, surviving reboots. It backs
// `cookrew list --all`, the roster UI, and is the reboot-safe fallback for
// cross-workspace identity resolution (spec: note agent-registry-spawn-broadca).
//
// The store's workspace files stay the source of truth for canvas layout;
// this registry is the flat "who exists, where, since when" index.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { LaunchFailure } from '../shared/launch-failure'

export interface AgentRegistryEntry {
  /** Terminal node id — stable across restarts, keys everything. */
  id: string
  name: string
  preset: string
  /** Launch command — lets resolution respawn/reattach a lost teammate. */
  command: string
  role: string | null
  cwd: string
  workspaceId: string
  workspaceName: string
  orch: boolean
  /**
   * The node's harness session reference at last spawn (claudeSessionId /
   * codexSessionRef / opencodeSessionId), so the legacy recover path (no
   * snapshot) can still resume the exact session instead of booting fresh
   * (R2 fix). Absent for pre-enrichment entries and plain shells.
   */
  sessionRef?: string | null
  /** Epoch ms of the FIRST spawn; preserved across re-spawns/reattaches. */
  spawnedAt: number
  /** False after dismiss/kill/agent exit; flips back true on re-spawn. */
  active: boolean
  /** Why it is not running, when that is more than resting. Cleared by a real spawn. */
  failure?: LaunchFailure | null
  updatedAt: number
}

/** Caller-supplied fields for a spawn; lifecycle fields are registry-owned. */
export type AgentRegistryUpsert = Omit<AgentRegistryEntry, 'spawnedAt' | 'active' | 'updatedAt' | 'failure'>

function isEntry(value: unknown): value is AgentRegistryEntry {
  const e = value as AgentRegistryEntry
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    typeof e.command === 'string' &&
    typeof e.workspaceId === 'string' &&
    typeof e.spawnedAt === 'number' &&
    typeof e.active === 'boolean'
  )
}

export class AgentRegistry {
  private entries: AgentRegistryEntry[]
  private readonly listeners = new Set<(entry: AgentRegistryEntry) => void>()

  constructor(private file = path.join(homedir(), '.cookrew', 'agents.json')) {
    this.entries = this.load()
  }

  private load(): AgentRegistryEntry[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isEntry) : []
    } catch (error) {
      console.error('Failed to load agent registry:', error)
      return []
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.entries, null, 2), 'utf8')
    } catch (error) {
      console.error('Failed to save agent registry:', error)
    }
  }

  /**
   * Hear each changed entry (spawn, respawn, deactivation): pages hold the
   * roster they fetched and merge these in, or an agent that exits stays
   * resting on screen until something remounts it.
   */
  onChange(listener: (entry: AgentRegistryEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private announce(entry: AgentRegistryEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch (error) {
        console.error('Agent registry listener failed:', error)
      }
    }
  }

  /** Every known agent, spawn order preserved (active and inactive). */
  list(): AgentRegistryEntry[] {
    return this.entries
  }

  lookup(id: string): AgentRegistryEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  /** Record a spawn: new entry, or refresh + reactivate an existing one. */
  upsert(input: AgentRegistryUpsert): AgentRegistryEntry {
    const prior = this.lookup(input.id)
    const entry: AgentRegistryEntry = {
      ...input,
      // Monotone-safe: a respawn upsert without a resolved ref must never
      // erase a previously bound one (the ref is a recovery signal).
      sessionRef: input.sessionRef ?? prior?.sessionRef ?? null,
      spawnedAt: prior?.spawnedAt ?? Date.now(),
      active: true,
      failure: null,
      updatedAt: Date.now()
    }
    this.put(entry)
    return entry
  }

  /**
   * It is not running, and here is why. Reached for a card that never spawned
   * as well, whose roster row is the only place to say so.
   */
  fail(input: AgentRegistryUpsert, failure: LaunchFailure): AgentRegistryEntry {
    const prior = this.lookup(input.id)
    const entry: AgentRegistryEntry = {
      ...input,
      sessionRef: input.sessionRef ?? prior?.sessionRef ?? null,
      spawnedAt: prior?.spawnedAt ?? Date.now(),
      active: false,
      failure,
      updatedAt: Date.now()
    }
    this.put(entry)
    return entry
  }

  /** What stopped it is gone, though nothing has started yet. */
  clearFailure(id: string): void {
    const prior = this.lookup(id)
    if (!prior?.failure) return
    this.put({ ...prior, failure: null, updatedAt: Date.now() })
  }

  private put(entry: AgentRegistryEntry): void {
    this.entries = this.lookup(entry.id)
      ? this.entries.map((e) => (e.id === entry.id ? entry : e))
      : [...this.entries, entry]
    this.save()
    this.announce(entry)
  }

  /** Update a harness session ref after a lazy bind (codex/opencode). */
  setSessionRef(id: string, sessionRef: string): void {
    const prior = this.lookup(id)
    if (!prior || prior.sessionRef === sessionRef) return
    this.entries = this.entries.map((e) =>
      e.id === id ? { ...e, sessionRef, updatedAt: Date.now() } : e
    )
    this.save()
  }

  /**
   * A renamed card's entry follows it at once, not at its next spawn: `--as
   * "Name"` falls back to this directory, and an old name must not keep
   * resolving to the agent after it was given up.
   */
  rename(id: string, name: string): void {
    const prior = this.lookup(id)
    if (!prior || prior.name === name) return
    const entry = { ...prior, name, updatedAt: Date.now() }
    this.entries = this.entries.map((e) => (e.id === id ? entry : e))
    this.save()
    this.announce(entry)
  }

  /** Dismiss/kill/agent exit — the entry stays for the roster, marked inactive. */
  deactivate(id: string): void {
    const prior = this.lookup(id)
    if (!prior || !prior.active) return
    const entry = { ...prior, active: false, updatedAt: Date.now() }
    this.entries = this.entries.map((e) => (e.id === id ? entry : e))
    this.save()
    this.announce(entry)
  }
}
