// PREVIEW STAND-IN for the companion's embed mode: the strata preview's mock
// machines have no companion behind them, so the shell's pool loads this page
// instead. It speaks exactly the embed's side of the handoff (ready / out /
// error, focus / blur, checked against window.parent on our own origin) and
// draws a placeholder terminal plus the attachments rail from the mock's
// LevelsAgentDetail. Nothing here ships: production loads the real companion.
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { EmbedToShell, LevelsAgentDetail } from '../../shared/strata'
import { fromShell } from './messages'

const params = new URLSearchParams(location.search)
/** The base this document was served under, '/m/<id>/', the way the companion finds its desktop. */
const base = location.pathname.match(/^\/m\/[^/]+\//)?.[0] ?? '/'

const tell = (message: EmbedToShell) => {
  if (window.parent !== window) window.parent.postMessage(message, location.origin)
}

/** The pairing token this origin holds for the machine, as the companion keeps it (cr_token:<id>). */
const authHeaders = (): Record<string, string> => {
  const id = base.split('/')[2] ?? ''
  const token = id ? localStorage.getItem(`cr_token:${decodeURIComponent(id).toLowerCase()}`) : null
  return token ? { authorization: `Bearer ${token}` } : {}
}

const load = async (agentId: string): Promise<LevelsAgentDetail> => {
  const response = await fetch(`${base}api/levels/agents/${encodeURIComponent(agentId)}`, { cache: 'no-store', headers: authHeaders() })
  if (response.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' as const })
  if (response.status === 404) throw Object.assign(new Error('not found'), { code: 'not-found' as const })
  if (response.status === 503) throw Object.assign(new Error('offline'), { code: 'offline' as const })
  if (!response.ok) throw Object.assign(new Error(`status ${response.status}`), { code: 'unreachable' as const })
  return (await response.json()) as LevelsAgentDetail
}

function StandIn() {
  const [agentId, setAgentId] = useState<string | null>(params.get('agent'))
  const [detail, setDetail] = useState<LevelsAgentDetail | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = fromShell(event, location.origin, window.parent, window)
      if (message?.type === 'strata:focus') setAgentId(message.agentId)
      if (message?.type === 'strata:blur') setAgentId(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') tell({ type: 'strata:out' })
    }
    addEventListener('message', onMessage)
    addEventListener('keydown', onKey)
    if (!params.get('agent')) tell({ type: 'strata:warm' })
    return () => {
      removeEventListener('message', onMessage)
      removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    setDetail(null)
    if (!agentId) return
    let live = true
    load(agentId).then(
      (next) => {
        if (!live) return
        setDetail(next)
        tell({ type: 'strata:ready', agentId })
      },
      (error: { code?: 'not-found' | 'offline' | 'unauthorized' | 'unreachable' }) => {
        if (live) tell({ type: 'strata:error', code: error.code ?? 'unreachable' })
      }
    )
    return () => {
      live = false
    }
  }, [agentId])

  if (!detail) return null
  const { agent, notes, browsers } = detail
  return (
    <main style={{ position: 'fixed', inset: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 180px) 1fr minmax(0, 200px)', font: '13px/1.5 ui-monospace, monospace', background: '#14120f', color: '#e8dfc6' }}>
      <aside aria-label="Notes" style={{ borderRight: '1px solid #3a352c', padding: 10, overflow: 'auto' }}>
        <b>Notes · {notes.length}</b>
        {notes.map((n) => (
          <div key={n.id} style={{ marginTop: 6, opacity: 0.85 }}>{n.title}</div>
        ))}
      </aside>
      <section aria-label="Terminal" style={{ padding: 16, overflow: 'auto' }}>
        <button type="button" onClick={() => tell({ type: 'strata:out' })} style={{ marginBottom: 12 }}>
          ← Back
        </button>
        <div style={{ color: '#ff9f0a' }}>STAND-IN TERMINAL · the real companion renders here</div>
        <div>
          {agent.name} · {agent.harness}
          {agent.model ? ` · ${agent.model}` : ''} · {agent.phase}
        </div>
        {agent.task && <div>&gt; {agent.task}</div>}
        {agent.reply && <div style={{ opacity: 0.8 }}>{agent.reply}</div>}
      </section>
      <aside aria-label="Browsers" style={{ borderLeft: '1px solid #3a352c', padding: 10, overflow: 'auto' }}>
        <b>Browsers · {browsers.length}</b>
        {browsers.map((b) => (
          <div key={b.id} style={{ marginTop: 6, opacity: b.live ? 1 : 0.6 }}>
            {b.title} {b.live ? '' : '· not live'}
            <div style={{ fontSize: 11, opacity: 0.7, overflowWrap: 'anywhere' }}>{b.url}</div>
          </div>
        ))}
      </aside>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('stand-in: #root missing')
createRoot(root).render(
  <StrictMode>
    <StandIn />
  </StrictMode>
)
