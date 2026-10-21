// LEVEL 3 — the agent's own terminal. Until the embed lands this is a stand-in
// box where EmbedPool mounts the companion's TerminalOverlay + Dock unchanged.
// Notes use the free space on the left and browsers the right, each with
// tabs; narrow gutters become rails; a phone raises a sheet over the terminal
// and never shrinks it.
import { useEffect, useState } from 'react'
import type { LevelsAgentDetail } from '../../shared/strata'
import { modelLine, phaseLine, replyLine, statusLine, taskLine } from '../summary/format'
import { useLevels } from './env'
import { rectStyle } from './Figure'
import { stateWords } from './link'
import type { LevelModel } from './model'

type Model = Extract<LevelModel, { level: 'terminal' }>
type Load = { state: 'loading' } | { state: 'ready'; detail: LevelsAgentDetail } | { state: 'failed'; why: string }

const useAgentDetail = (base: string | undefined, agentId: string | undefined, live: boolean): Load => {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  useEffect(() => {
    if (!base || !agentId) return
    if (!live) return setLoad({ state: 'failed', why: 'offline' })
    const ctrl = new AbortController()
    setLoad({ state: 'loading' })
    fetch(`${base}api/levels/agents/${encodeURIComponent(agentId)}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? (res.json() as Promise<LevelsAgentDetail>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((detail) => setLoad({ state: 'ready', detail }))
      .catch((error: Error) => !ctrl.signal.aborted && setLoad({ state: 'failed', why: error.message }))
    return () => ctrl.abort()
  }, [base, agentId, live])
  return load
}

interface Tab {
  id: string
  title: string
  body: string
  sub?: string
}

function Panel({ kind, tabs, initial, rect }: { kind: 'notes' | 'browsers'; tabs: Tab[]; initial?: string; rect?: { x: number; y: number; w: number; h: number } }) {
  const [active, setActive] = useState(() => tabs.find((t) => t.id === initial)?.id ?? tabs[0]?.id)
  const current = tabs.find((t) => t.id === active) ?? tabs[0]
  return (
    <section className={`side-panel ${kind}`} style={rect ? rectStyle(rect) : undefined} aria-label={kind === 'notes' ? 'Notes' : 'Browsers'}>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === current?.id} className="tab" title={t.title} onClick={() => setActive(t.id)}>
            {kind === 'notes' ? '📝' : '🌐'} {t.title}
          </button>
        ))}
      </div>
      {current ? (
        <div className="tab-body" role="tabpanel">
          {current.sub && <div className="address">{current.sub}</div>}
          <pre>{current.body}</pre>
        </div>
      ) : (
        <div className="tab-body muted">No {kind} wired to this agent.</div>
      )}
    </section>
  )
}

export function TerminalLevel({ model }: { model: Model }) {
  const env = useLevels()
  const { machine, workspace, agent, layout } = model
  const live = machine?.link === 'live'
  const load = useAgentDetail(machine?.base, agent?.id, live)
  const [sheet, setSheet] = useState<'notes' | 'browsers' | null>(env.goOptions.attachmentId || env.goOptions.allAttachments ? 'notes' : null)
  if (!machine || !workspace || !agent) return <div className="level level-plate">This agent is not here any more.</div>

  const detail = load.state === 'ready' ? load.detail : null
  const notes: Tab[] = detail ? detail.notes.map((n) => ({ id: n.id, title: n.title, body: n.content })) : agent.attachments.filter((a) => a.kind === 'note').map((a) => ({ id: a.id, title: a.title, body: '(last known title only)' }))
  const browsers: Tab[] = detail
    ? detail.browsers.map((b) => ({ id: b.id, title: b.title, sub: `${b.url ?? 'no address'}${b.live ? '' : ' · not running'}`, body: b.tabs.map((t) => t.url).join('\n') || '(no tabs)' }))
    : agent.attachments.filter((a) => a.kind === 'browser').map((a) => ({ id: a.id, title: a.title, sub: a.host ?? undefined, body: '(last known address only)' }))
  const focusId = env.goOptions.attachmentId
  const phase = phaseLine(agent, Date.now(), !live)

  return (
    <div className="level level-terminal">
      <div ref={env.useAnchor('terminal')} className="terminal-standin" style={rectStyle(layout.terminal)} role="region" aria-label={`${agent.name}'s terminal on ${machine.name}`}>
        <pre>
          {live
            ? `╭─ ${agent.name} · ${modelLine(agent)}\n│ ${phase.label} · ${phase.elapsed} · ${phase.source}\n│ ${statusLine(agent, false)}\n│\n│ 📌 ${taskLine(agent)}\n│ ↩ ${replyLine(agent)}\n│\n╰─ the companion's TerminalOverlay + Dock mount here, unchanged (EmbedPool)`
            : `  ${machine.name} is ${stateWords(machine, env.now())}\n  last known: ${phase.label} ${phase.elapsed}\n\n  📌 ${taskLine(agent)}\n  ↩ ${replyLine(agent)}\n\n  The terminal opens when the machine is back.`}
        </pre>
      </div>
      {layout.notes && <Panel kind="notes" tabs={notes} initial={focusId} rect={layout.notes} />}
      {layout.browsers && <Panel kind="browsers" tabs={browsers} initial={focusId} rect={layout.browsers} />}
      {layout.rails &&
        (['notes', 'browsers'] as const).map((kind) => (
          <div key={kind} className={`rail ${kind}`} style={rectStyle(layout.rails![kind])}>
            {(kind === 'notes' ? notes : browsers).map((t) => (
              <button key={t.id} type="button" className="rail-tab" title={t.title} aria-label={`${kind === 'notes' ? 'Note' : 'Browser'}: ${t.title}`} onClick={() => setSheet(kind)}>
                {kind === 'notes' ? '📝' : '🌐'}
              </button>
            ))}
          </div>
        ))}
      {(layout.sheet || layout.rails) && (notes.length > 0 || browsers.length > 0) && (
        <button type="button" className="sheet-handle" onClick={() => setSheet(sheet ? null : 'notes')} aria-expanded={!!sheet}>
          📝 {notes.length} · 🌐 {browsers.length}
        </button>
      )}
      {sheet && (layout.sheet || layout.rails) && (
        <div className={`sheet${layout.rails ? ' over-gutter' : ''}`} role="dialog" aria-label="Notes and browsers">
          <div className="seg">
            <button type="button" aria-pressed={sheet === 'notes'} onClick={() => setSheet('notes')}>
              Notes {notes.length}
            </button>
            <button type="button" aria-pressed={sheet === 'browsers'} onClick={() => setSheet('browsers')}>
              Browsers {browsers.length}
            </button>
            <button type="button" className="close" onClick={() => setSheet(null)} aria-label="Close">
              ✕
            </button>
          </div>
          <Panel key={sheet} kind={sheet} tabs={sheet === 'notes' ? notes : browsers} initial={focusId} />
        </div>
      )}
    </div>
  )
}
