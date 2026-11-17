import { registerScopeState } from '../machine-scope'
import type { RemoteCard } from './remote-machine'
import { remotePlace, type RemoteItemRef } from './remote-machine-store'
import { callRemote } from './use-remote-machine'

/**
 * A FACE OF ANOTHER MACHINE, OPENED FROM THE BAR (phase 6, plan
 * docs/hitl-cross-workspace-2026-11-15 · v6.2). The bar enters that machine at
 * the workspace its fleet named (remote-machine-store.ts · remotePlace) and
 * leaves a pending target here; the machine's own view (RemoteMachineView.tsx)
 * settles it from its own read: to the agent once that read holds it, to the
 * card holding the artifact. Until then, and if it never comes, the view stays
 * on the machine: a stale or wrong target is never opened.
 */

export interface RemoteTarget {
  readonly machineId: string
  readonly workspaceId: string
  readonly kind: 'agent' | 'item'
  /** The agent's or the artifact's own id on that machine. */
  readonly id: string
  readonly name: string
  readonly itemKind?: 'note' | 'browser'
  /** When it was asked for: past REMOTE_OPEN_MS it is given up. */
  readonly at: number
}

/** How long the machine's view is waited on to hold the target. */
export const REMOTE_OPEN_MS = 10_000

export type RemoteStep =
  | { readonly step: 'wait' }
  | { readonly step: 'drop' }
  /** An artifact no agent's card holds (loose, or gone): the workspace's artifacts. */
  | { readonly step: 'items' }
  | { readonly step: 'agent'; readonly agent: { readonly id: string; readonly name: string } }
  | { readonly step: 'item'; readonly agent: { readonly id: string; readonly name: string }; readonly item: RemoteItemRef }

export interface StandingAt {
  readonly machineId: string | null
  readonly workspaceId: string | null
  /** An agent the owner opened there meanwhile: their place stands. */
  readonly agentId?: string | null
}

/** The machine view's read: which machine and workspace it was for, when it landed, what it held. */
export interface RemoteCardsRead {
  readonly machineId: string
  readonly workspaceId: string | null
  readonly at: number
  readonly cards: readonly RemoteCard[]
}

/**
 * The cards that may settle this target: a read of its own machine and
 * workspace that landed after it was asked for. Never the last key's state,
 * nor a copy kept from an earlier visit. Pure.
 */
export function cardsFor(target: RemoteTarget, read: RemoteCardsRead | null): readonly RemoteCard[] | null {
  if (!read || read.machineId !== target.machineId || read.workspaceId !== target.workspaceId || read.at < target.at) return null
  return read.cards
}

/** Where the target stands in the machine's read, or why not yet. Pure. */
export function resolveRemoteTarget(target: RemoteTarget, at: StandingAt, cards: readonly RemoteCard[] | null, now: number): RemoteStep {
  if (at.machineId !== target.machineId || at.workspaceId !== target.workspaceId || (at.agentId ?? null) !== null) return { step: 'drop' }
  const late = now - target.at >= REMOTE_OPEN_MS
  const here = (cards ?? []).filter((card) => card.workspace.id === target.workspaceId)
  if (target.kind === 'agent') {
    const card = here.find((one) => one.id === target.id)
    if (card) return { step: 'agent', agent: { id: card.id, name: card.name } }
    return late ? { step: 'drop' } : { step: 'wait' }
  }
  for (const card of here) {
    const item = card.items.find((one) => one.id === target.id)
    if (item) return { step: 'item', agent: { id: card.id, name: card.name }, item: { id: item.id, title: item.title, kind: item.kind } }
  }
  return late ? { step: 'items' } : { step: 'wait' }
}

let pending: RemoteTarget | null = null
let timer: ReturnType<typeof setTimeout> | null = null

const clear = (): void => {
  pending = null
  if (timer !== null) clearTimeout(timer)
  timer = null
}

const standing = (): StandingAt => {
  const at = remotePlace.get()
  return { machineId: at.machine?.id ?? null, workspaceId: at.workspace?.id ?? null, agentId: at.agent?.id ?? null }
}

function apply(step: RemoteStep): void {
  if (step.step === 'wait') return
  clear()
  if (step.step === 'items') remotePlace.side('items')
  if (step.step === 'agent' || step.step === 'item') remotePlace.agent(step.agent)
  if (step.step === 'item') remotePlace.item(step.item)
}

export const remoteOpen = {
  /** Wait for this target (the bar has entered its machine and workspace). */
  request(target: RemoteTarget): void {
    clear()
    pending = target
    // Given up after the wait with no read that held it: the machine stays (an artifact: its workspace's artifacts), no wrong target.
    timer = setTimeout(() => {
      timer = null
      if (pending === target) apply(resolveRemoteTarget(target, standing(), null, target.at + REMOTE_OPEN_MS))
    }, REMOTE_OPEN_MS)
  },
  pending: (): RemoteTarget | null => pending,
  /** The machine's view read its cards (RemoteMachineView.tsx): go on to the target if that read holds it. */
  settle(at: StandingAt, read: RemoteCardsRead | null, now = Date.now()): void {
    if (pending) apply(resolveRemoteTarget(pending, at, cardsFor(pending, read), now))
  },
  clear
}

/** What the bar knows of a face it opens on another machine (remote-hitl.ts entries). */
export interface RemoteFace {
  readonly machineId: string
  readonly machineName: string
  readonly machineOs: string | null
  readonly workspaceId: string
  readonly workspaceName: string
  readonly kind: 'agent' | 'item'
  readonly id: string
  readonly name: string
  readonly itemKind?: 'note' | 'browser'
}

/**
 * Into that machine, at the workspace its fleet named, the target pending
 * (RemoteMachineView.tsx settles it). The zoom stays where it is: the machine's
 * view stands over it, and stepping out comes back here.
 */
export function openRemoteFace(face: RemoteFace, now = Date.now()): void {
  remotePlace.enter({ id: face.machineId, name: face.machineName, os: face.machineOs })
  remotePlace.workspace({ id: face.workspaceId, name: face.workspaceName })
  remoteOpen.request({
    machineId: face.machineId,
    workspaceId: face.workspaceId,
    kind: face.kind,
    id: face.id,
    name: face.name,
    ...(face.itemKind ? { itemKind: face.itemKind } : {}),
    at: now
  })
}

/** A reply opened on its card is read, on its own machine (the allow-listed POST api/terminal/:id/seen). */
export function readRemoteReply(machineId: string, agentId: string): void {
  void callRemote(machineId, 'POST', `api/terminal/${encodeURIComponent(agentId)}/seen`)
}

// Waiting on one machine: left, or another entered, it is nobody's target any more.
remotePlace.subscribe(() => {
  if (pending && remotePlace.get().machine?.id !== pending.machineId) clear()
})
// Asked from the machine in scope, through its keys: a change of machine lets go of it.
registerScopeState('remote open', () => remoteOpen.clear(), 'stop')
