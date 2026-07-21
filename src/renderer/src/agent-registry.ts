import { useEffect, useState } from 'react'
import type { TerminalNodeData } from '../../shared/model'
import { cookrew } from './api'

/**
 * Agent-registry adapter (spawn-broadcast UX lane, note item 2). The durable
 * cross-workspace registry + global spawn event are Forge's backend lane; this
 * module lets the toast and roster build ahead of it. Every call feature-
 * detects the real method on the cookrew() bridge and falls back to a mock
 * derived from the active workspace so the UI is exercisable now. When Forge
 * lands the registry API, detection flips and the mock goes dormant — no
 * component change.
 *
 * Proposed contract (appended to the agent-registry-spawn-broadca note):
 *   AgentRegistryEntry = { id, name, preset, role, cwd, workspaceId,
 *                          workspaceName, spawnedAt, orch, active }
 *   api.listAgents() => Promise<AgentRegistryEntry[]>   // global, all workspaces
 *   api.onAgentSpawn(cb) => unsubscribe                 // GLOBAL spawn event
 *   api.onAgentRegistry(cb) => unsubscribe              // roster changed (spawn/dismiss/active)
 */

export interface AgentRegistryEntry {
  id: string
  name: string
  preset: string
  role: string | null
  cwd: string
  workspaceId: string
  workspaceName: string
  spawnedAt: number
  orch: boolean
  active: boolean
}

interface RegistryBridge {
  listAgents?: () => Promise<AgentRegistryEntry[]>
  onAgentSpawn?: (cb: (entry: AgentRegistryEntry) => void) => () => void
  onAgentRegistry?: (cb: (list: AgentRegistryEntry[]) => void) => () => void
}

function bridge(): RegistryBridge {
  return cookrew() as unknown as RegistryBridge
}

/** True once Forge's real registry API is present on the bridge. */
export function hasRegistry(): boolean {
  return typeof bridge().listAgents === 'function'
}

/**
 * Mock spawn channel: a window CustomEvent so a real spawn (or a QA
 * `window.dispatchEvent`) surfaces a toast even before the backend event
 * exists. Real onAgentSpawn, when present, is used instead.
 */
const MOCK_SPAWN_EVENT = 'cookrew:mock-spawn'

/** Roster from the registry (real) or a mock built from the active workspace. */
export async function listAgents(): Promise<AgentRegistryEntry[]> {
  const fn = bridge().listAgents
  if (fn) {
    // Bridge may return a bare array (remote unwraps) or an {agents} wrapper.
    const res = (await fn()) as AgentRegistryEntry[] | { agents?: AgentRegistryEntry[] } | undefined
    if (Array.isArray(res)) return res
    return res?.agents ?? []
  }
  return mockRoster()
}

/**
 * Subscribe to global spawn events. Real event when present; otherwise the
 * window mock channel, so the toast is demonstrable without the backend.
 */
export function onAgentSpawn(cb: (entry: AgentRegistryEntry) => void): () => void {
  const fn = bridge().onAgentSpawn
  if (fn) return fn(cb)
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<AgentRegistryEntry>).detail
    if (detail) cb(detail)
  }
  window.addEventListener(MOCK_SPAWN_EVENT, listener)
  return () => window.removeEventListener(MOCK_SPAWN_EVENT, listener)
}

/** Subscribe to roster changes (spawn / dismiss / active toggle). */
export function onAgentRegistry(cb: (list: AgentRegistryEntry[]) => void): () => void {
  const fn = bridge().onAgentRegistry
  if (fn) return fn(cb)
  // Mock: refresh the roster whenever a mock spawn fires.
  const listener = (): void => void mockRoster().then(cb)
  window.addEventListener(MOCK_SPAWN_EVENT, listener)
  return () => window.removeEventListener(MOCK_SPAWN_EVENT, listener)
}

/** Live roster hook: initial fetch + subscription, newest spawn first. */
export function useRoster(): AgentRegistryEntry[] {
  const [roster, setRoster] = useState<AgentRegistryEntry[]>([])
  useEffect(() => {
    let alive = true
    void listAgents().then((list) => {
      if (alive) setRoster(list)
    })
    const off = onAgentRegistry((list) => setRoster(list))
    return () => {
      alive = false
      off()
    }
  }, [])
  return roster
}

// ---- mock: derive a roster from the active workspace's terminals ----

async function mockRoster(): Promise<AgentRegistryEntry[]> {
  try {
    const state = await cookrew().getWorkspace()
    const terminals = state.nodes.filter((n) => n.kind === 'terminal') as TerminalNodeData[]
    return terminals.map((t, i) => ({
      id: t.id,
      name: t.name,
      preset: t.preset,
      role: t.role ?? null,
      cwd: t.cwd,
      workspaceId: 'active',
      workspaceName: state.name,
      spawnedAt: Date.now() - i * 1000,
      orch: t.orch,
      active: true
    }))
  } catch {
    return []
  }
}
