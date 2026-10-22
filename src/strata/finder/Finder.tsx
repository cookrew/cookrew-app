// THE FINDER: ⌘K or / at any level. Typing lights matching avatars wherever
// you are (the shell passes the glow set to the levels); ↑↓ move the active
// hit, which the level's highlight mirrors; Enter dives to it. An empty query
// lists "Waiting on you", so "/" then Enter answers the oldest waiting agent.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StrataMachine, StrataPath } from '../../shared/strata'
import type { AgentHit, FleetIndex } from '../seams'
import { codeMatches, type CodedAgent } from './codes'
import { agentKey, hitPath } from './search'

const LIMIT = 8
const GLOW_LIMIT = 2000

export interface FinderProps {
  fleet: StrataMachine[]
  /** Harbor's FleetIndex at the merge; the local one until then. */
  index: FleetIndex
  /** Jump codes, on top of whichever index runs. */
  coded: readonly CodedAgent[]
  /** Where the user is: breaks name ties toward it. */
  context: StrataPath
  initialQuery: string
  onClose: () => void
  onGlow: (keys: ReadonlySet<string> | null) => void
  onActive: (target: StrataPath | null) => void
  onDive: (target: StrataPath) => void
}

const placeOf = (fleet: StrataMachine[], hit: AgentHit) => {
  const machine = fleet.find((m) => m.id === hit.machineId)
  const workspace = machine?.levels?.workspaces.find((w) => w.id === hit.workspaceId)
  const agent = workspace?.agents.find((a) => a.id === hit.agentId)
  return { machine, workspace, agent }
}

export function Finder({ fleet, index, coded, context, initialQuery, onClose, onGlow, onActive, onDive }: FinderProps) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const near = useMemo(() => ({ machine: context.machine, workspace: context.workspace }), [context.machine, context.workspace])
  const typed = query.trim().length > 0
  // A jump code ('5d', or a lone '5') names agents directly; anything else is a name search.
  const byCode = useMemo(() => codeMatches(coded, query), [coded, query])
  const hits = useMemo((): AgentHit[] => {
    if (!typed) return index.attention().slice(0, LIMIT)
    if (byCode.length > 0) return byCode.slice(0, LIMIT).map((c) => ({ machineId: c.machineId, workspaceId: c.workspaceId, agentId: c.agentId, name: c.name, score: 0 }))
    return index.find(query, LIMIT, near)
  }, [index, query, typed, byCode, near])
  const glow = useMemo(
    () => (!typed ? null : new Set(byCode.length > 0 ? byCode.map((c) => c.key) : index.find(query, GLOW_LIMIT, near).map((h) => agentKey(h.machineId, h.agentId)))),
    [index, query, typed, byCode, near]
  )
  const codes = useMemo(() => new Map(coded.map((c) => [c.key, c.code])), [coded])
  const current = hits[Math.min(active, hits.length - 1)] ?? null

  useEffect(() => input.current?.focus(), [])
  useEffect(() => setActive(0), [query])
  useEffect(() => onGlow(glow), [glow, onGlow])
  useEffect(() => onActive(current ? hitPath(current) : null), [current, onActive])
  useEffect(() => () => onGlow(null), [onGlow])

  return (
    <div className="finder-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-label="Find an agent">
        <input
          ref={input}
          className="finder-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="finder-list"
          aria-activedescendant={current ? `finder-opt-${active}` : undefined}
          aria-autocomplete="list"
          placeholder="Name, workspace or jump code (3f)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setActive((i) => Math.max(0, Math.min(hits.length - 1, i + step)))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (current) onDive(hitPath(current))
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="finder-meta">{typed ? `${glow?.size ?? 0} found` : hits.length ? 'Waiting on you, then replied' : 'Nothing waiting on you'}</div>
        <ul id="finder-list" role="listbox" className="finder-list">
          {hits.map((hit, i) => {
            const { machine, workspace, agent } = placeOf(fleet, hit)
            const lastKnown = machine && machine.link !== 'live'
            return (
              <li
                key={`${hit.machineId}/${hit.agentId}`}
                id={`finder-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : undefined}
                onPointerEnter={() => setActive(i)}
                onClick={() => onDive(hitPath(hit))}
              >
                <span className={`sum-dot ph-${lastKnown ? 'offline' : (agent?.phase ?? 'idle')}`} />
                <b>{hit.name}</b>
                <span className="code-chip">{codes.get(`${hit.machineId}/${hit.agentId}`)}</span>
                <span className="muted">
                  {workspace?.name ?? '?'} · {machine?.name ?? '?'}
                  {lastKnown ? ' · last known' : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
