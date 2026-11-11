import { registerScopeState } from '../machine-scope'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * ONE DRAFT PER AGENT (owner, 2026-11-01): the global prompt with @agent and
 * that agent's card reply box are bound — they read and write the same text,
 * so a word typed in one shows in the other. The draft with no agent (a new
 * agent's first prompt) has its own key. In memory only: a draft is the
 * moment's, not a record.
 */

const NEW_AGENT = '\u0000new'
const drafts = new Map<string, string>()
const listeners = new Set<() => void>()

export const draftKey = (agentId: string | null): string => agentId ?? NEW_AGENT

export const getDraft = (key: string): string => drafts.get(key) ?? ''

export function setDraft(key: string, text: string): void {
  if (getDraft(key) === text) return
  if (text) drafts.set(key, text)
  else drafts.delete(key)
  for (const cb of listeners) cb()
}

// A draft is for an agent of ONE machine, or for an agent about to be made on
// it: typed for the last machine, it must not be sent on the next.
registerScopeState('prompt drafts', () => {
  if (drafts.size === 0) return
  drafts.clear()
  for (const cb of listeners) cb()
})

/** The agents that hold a draft now (the new agent's draft is no agent's). */
export const draftedAgents = (): string[] => [...drafts.keys()].filter((key) => key !== NEW_AGENT)

export function subscribeDrafts(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function useDraft(key: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(subscribeDrafts, () => getDraft(key), () => '')
  const set = useCallback((next: string) => setDraft(key, next), [key])
  return [text, set]
}
