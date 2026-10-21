// HARBOR'S QA PAGE (preview only, /embed/qa.html): the fleet, the finder, the
// "needs you" pins and a dive from any row, with the pool's frames and its
// last dive time on screen. It stands in for the levels until they land, so
// the fleet store, the index and the embed pool can be driven end to end.
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { StrataPath } from '../../shared/strata'
import { onlinePicture } from '../fleet/fleet-online'
import { useFleetIndex } from '../fleet/fleet-index'
import { fleetStore, useFleet } from '../fleet/use-fleet'
import { createHoverIntent, obviousTarget } from './budget'
import { embedPool, setEmbedOut } from './browser-pool'
import { TerminalLevel, useEmbedView } from './TerminalLevel'

/** PREVIEW ONLY: store the mock's pairing tokens the way /me's pair flow does (cr_token:<id>). */
const pairAll = async () => {
  const tokens = (await (await fetch('/mock/pair')).json()) as Record<string, string>
  for (const [id, token] of Object.entries(tokens)) localStorage.setItem(`cr_token:${id.toLowerCase()}`, token)
}
const setSwitch = (body: Record<string, unknown>) =>
  fetch('/mock/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const timers = { setTimer: (run: () => void, ms: number) => setTimeout(run, ms), clearTimer: (h: unknown) => clearTimeout(h as number) }

function Qa() {
  const machines = useFleet()
  const index = useFleetIndex()
  const view = useEmbedView()
  const [path, setPath] = useState<StrataPath>({})
  const [query, setQuery] = useState('')
  const intent = useMemo(() => createHoverIntent((id) => embedPool().prewarm(id), timers), [])
  const target = obviousTarget(path, machines)

  useEffect(() => setEmbedOut(() => setPath({ machine: path.machine, workspace: path.workspace })), [path.machine, path.workspace])
  useEffect(() => {
    if (target) embedPool().prewarm(target)
  }, [target])

  const dive = (machine: string, workspace: string, agent: string) => setPath({ machine, workspace, agent })
  const hits = query ? index.find(query, 8) : index.attention().slice(0, 8)
  const online = onlinePicture(machines, fleetStore().presence())

  if (path.machine && path.workspace && path.agent) {
    return <TerminalLevel path={{ machine: path.machine, workspace: path.workspace, agent: path.agent }} />
  }
  return (
    <main style={{ font: '13px/1.5 ui-monospace, monospace', padding: 20, display: 'grid', gap: 16 }}>
      <header>
        <b>{online.label}</b>
        {online.capped ? ' · at the relay cap' : ''} · frames {view.frames.map((f) => `${f.machineId}:${f.state}`).join(' ') || 'none'}
        {view.lastDive ? ` · last dive ${view.lastDive.warm ? 'warm' : 'cold'} ${Math.round(view.lastDive.ms)} ms` : ''}
      </header>
      <nav aria-label="Mock switches" style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => void pairAll()}>pair all</button>
        <button onClick={() => void setSwitch({ auth: true })}>auth on</button>
        <button onClick={() => void setSwitch({ auth: false, storm: [], hang: [] })}>all clear</button>
        <button onClick={() => void setSwitch({ storm: ['syn-studio'] })}>storm studio</button>
        <button onClick={() => void setSwitch({ hang: ['syn-cloud'] })}>hang night-runner</button>
        <button onClick={() => void fleetStore().refresh()}>presence now</button>
      </nav>
      <section>
        <input aria-label="Find an agent" placeholder="find an agent…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div>{query ? 'matches' : 'needs you'}:</div>
        {hits.map((hit) => (
          <button key={`${hit.machineId}/${hit.agentId}`} style={{ display: 'block' }} onClick={() => dive(hit.machineId, hit.workspaceId, hit.agentId)}>
            {hit.name} · {machines.find((m) => m.id === hit.machineId)?.name} · {hit.score}
          </button>
        ))}
      </section>
      {machines.map((m) => (
        <section key={m.id} onPointerEnter={() => intent.enter(m.id)} onPointerLeave={() => intent.leave()}>
          <b>{m.name}</b> · {m.profile?.kind ?? 'unknown'} · {m.link}
          {m.stale ? ' · stale' : ''}
          {fleetStore().detail(m.id) ? ` (${fleetStore().detail(m.id)})` : ''}
          {m.levels?.workspaces.map((w) => (
            <div key={w.id} style={{ paddingLeft: 12 }}>
              {w.name} ({w.state}):{' '}
              {w.agents.slice(0, 12).map((a) => (
                <button key={a.id} onClick={() => dive(m.id, w.id, a.id)}>
                  {a.name}
                </button>
              ))}
            </div>
          ))}
        </section>
      ))}
    </main>
  )
}

// For the headless driver: the pool's view (frames, last dive time), read-only.
Object.assign(globalThis, { __strataEmbedView: () => embedPool().getSnapshot() })

const root = document.getElementById('root')
if (!root) throw new Error('qa: #root missing')
createRoot(root).render(
  <StrictMode>
    <Qa />
  </StrictMode>
)
