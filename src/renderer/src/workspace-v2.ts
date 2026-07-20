import { useSyncExternalStore } from 'react'
import type { CanvasNode, WorkspaceMeta, WorkspaceState } from '../../shared/model'
import { normalizeDirs } from '../../shared/model'
import { cookrew, isRemoteMode } from './api'

/**
 * Workspace-v2 adapter (picker/workspace UX lane). The keystone model change
 * — a workspace holding an ordered dirs[] with dirs[0] as primary, plus git
 * awareness — is Forge's backend lane. This module lets the UI build ahead of
 * that: every call feature-detects the real method on the cookrew() bridge and
 * falls back to an in-memory mock so the panels are fully interactive now.
 * When Forge lands the real API + model fields, detection flips and the mock
 * store goes dormant automatically — no component change needed.
 *
 * Proposed contract (appended to the workspace-v2-spec note for Forge):
 *   WorkspaceState/WorkspaceMeta gain `dirs: string[]` (dirs[0] === legacy dir)
 *   TeamForkSpec gains `dirs?: string[]`, `useWorktree?: boolean`
 *   TeamForkChoice gains `targetDir?: string`
 *   api: removeWorkspace(id), addWorkspaceDir(id,path), removeWorkspaceDir(id,path),
 *        setPrimaryDir(id,path), setTerminalCwd(nodeId,dir), pickDirectory(),
 *        gitInfo(dir) => GitInfo
 */

/** Mirrors Forge's GitInfo contract (root/branch nullable off-repo). */
export interface GitInfo {
  isRepo: boolean
  root: string | null
  branch: string | null
  dirty: boolean
  ahead: number
  behind: number
  error?: string
}

interface WorkspaceV2Bridge {
  removeWorkspace?: (id: string) => Promise<unknown>
  addWorkspaceDir?: (id: string, path: string) => Promise<unknown>
  removeWorkspaceDir?: (id: string, path: string) => Promise<unknown>
  setPrimaryDir?: (id: string, path: string) => Promise<unknown>
  setTerminalCwd?: (nodeId: string, dir: string) => Promise<unknown>
  pickDir?: () => Promise<string | null>
  gitInfo?: (dir: string) => Promise<GitInfo>
}

function bridge(): WorkspaceV2Bridge {
  return cookrew() as unknown as WorkspaceV2Bridge
}

/** True once Forge's real workspace-v2 API is present on the bridge. */
export function hasWorkspaceV2(): boolean {
  return typeof bridge().addWorkspaceDir === 'function'
}

/** dirs[] via the shared normalizer (handles legacy single-dir workspaces). */
export function metaDirs(meta: { dir?: string; dirs?: string[] }): string[] {
  return normalizeDirs(meta)
}

/** A terminal's cwd, clamped to a member of the workspace dirs. */
export function terminalCwd(node: CanvasNode, dirs: string[]): string {
  if (node.kind !== 'terminal') return dirs[0] ?? ''
  return dirs.includes(node.cwd) ? node.cwd : (dirs[0] ?? node.cwd)
}

/** Basename for a compact directory label; keeps the tail on collisions. */
export function dirLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

// ---- mock store (only consulted while hasWorkspaceV2() is false) ----

type Listener = () => void
const listeners = new Set<Listener>()
/** Per-workspace dir override, seeded lazily from the live [dir]. */
const mockDirs = new Map<string, string[]>()
/** Per-terminal cwd override. */
const mockCwd = new Map<string, string>()
let mockCounter = 0

function emit(): void {
  mockCounter += 1
  for (const listener of listeners) listener()
}

/**
 * A mock mutation is only correct while the backend is genuinely absent (early
 * dev, demo mode). If it ever fires in a real build it means a bridge method is
 * missing — the panel would show a working preview that never persists, so warn
 * loudly (once per op) rather than fail silently.
 */
const warnedMockOps = new Set<string>()
function warnMock(op: string): void {
  if (isRemoteMode() || warnedMockOps.has(op)) return
  warnedMockOps.add(op)
  console.warn(
    `[workspace-v2] ${op} has no backend bridge — mutating local preview only, ` +
      'changes will NOT persist. The workspace API is not wired in this build.'
  )
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function mockSnapshot(): number {
  return mockCounter
}

function seedDirs(wsId: string, seed: string[]): string[] {
  const existing = mockDirs.get(wsId)
  if (existing) return existing
  const copy = [...seed]
  mockDirs.set(wsId, copy)
  return copy
}

/**
 * Live dirs for a workspace: the real meta.dirs when the backend is present,
 * otherwise the mock overlay (seeded from the legacy single dir). Subscribes
 * to the mock store so components re-render on mock mutations.
 */
export function useWorkspaceDirs(meta: WorkspaceMeta | undefined): string[] {
  useSyncExternalStore(subscribe, mockSnapshot, mockSnapshot)
  if (!meta) return []
  if (hasWorkspaceV2()) return metaDirs(meta)
  return seedDirs(meta.id, metaDirs(meta))
}

/** Effective cwd for a terminal, honouring a pending mock override. */
export function useTerminalCwd(node: CanvasNode, dirs: string[]): string {
  useSyncExternalStore(subscribe, mockSnapshot, mockSnapshot)
  if (node.kind !== 'terminal') return dirs[0] ?? ''
  if (!hasWorkspaceV2()) {
    const override = mockCwd.get(node.id)
    if (override && dirs.includes(override)) return override
  }
  return terminalCwd(node, dirs)
}

// ---- mutations (real bridge → fall back to mock) ----

export async function removeWorkspace(id: string): Promise<void> {
  const fn = bridge().removeWorkspace
  if (fn) {
    await fn(id)
    return
  }
  warnMock('removeWorkspace')
  mockDirs.delete(id)
  emit()
}

export async function addWorkspaceDir(meta: WorkspaceMeta, path: string): Promise<void> {
  const clean = path.trim().replace(/\/+$/, '')
  if (!clean) return
  const fn = bridge().addWorkspaceDir
  if (fn) {
    await fn(meta.id, clean)
    return
  }
  warnMock('addWorkspaceDir')
  const dirs = seedDirs(meta.id, metaDirs(meta))
  if (!dirs.includes(clean)) mockDirs.set(meta.id, [...dirs, clean])
  emit()
}

export async function removeWorkspaceDir(meta: WorkspaceMeta, path: string): Promise<void> {
  const fn = bridge().removeWorkspaceDir
  if (fn) {
    await fn(meta.id, path)
    return
  }
  warnMock('removeWorkspaceDir')
  const dirs = seedDirs(meta.id, metaDirs(meta))
  if (dirs.length > 1) mockDirs.set(meta.id, dirs.filter((d) => d !== path))
  emit()
}

export async function setPrimaryDir(meta: WorkspaceMeta, path: string): Promise<void> {
  const fn = bridge().setPrimaryDir
  if (fn) {
    await fn(meta.id, path)
    return
  }
  warnMock('setPrimaryDir')
  const dirs = seedDirs(meta.id, metaDirs(meta))
  if (dirs.includes(path)) mockDirs.set(meta.id, [path, ...dirs.filter((d) => d !== path)])
  emit()
}

export async function setTerminalCwd(nodeId: string, dir: string): Promise<void> {
  const fn = bridge().setTerminalCwd
  if (fn) {
    await fn(nodeId, dir)
    return
  }
  warnMock('setTerminalCwd')
  mockCwd.set(nodeId, dir)
  emit()
}

/**
 * Native directory picker. Desktop returns an absolute path (or null on
 * cancel); on the phone there is no native picker, so callers fall back to a
 * text field — signalled by a null return with isRemoteMode() true.
 */
export async function pickDirectory(): Promise<string | null> {
  const fn = bridge().pickDir
  if (fn) return fn()
  return null
}

/** True when a native directory picker is available (desktop with the API). */
export function hasNativeDirPicker(): boolean {
  return typeof bridge().pickDir === 'function' && !isRemoteMode()
}

/**
 * Git info for a dir, or null when the backend has no gitInfo yet. Fresco's
 * git chips consume this; kept here so both lanes read one shape.
 */
export async function gitInfo(dir: string): Promise<GitInfo | null> {
  const fn = bridge().gitInfo
  if (!fn) return null
  return fn(dir).catch(() => null)
}

/** Snapshot-workspace helper for the picker: dirs of the active workspace. */
export function stateDirs(state: WorkspaceState): string[] {
  return metaDirs(state)
}
