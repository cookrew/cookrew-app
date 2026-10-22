// LEVEL 3 FALLBACK. Level 3 is Harbor's embed: the companion's full view,
// unchanged, with its own header, Back and rails. This level shows only for an
// offline or outdated machine or a failed dive (the top bar stays). Its layout
// follows Harbor's rail-layout rules: the view takes the whole stage, desktop
// edge tabs open a drawer over it, a phone gets one tab and a bottom sheet.
import { useEffect, useState } from 'react'
import type { LevelsAgentDetail } from '../../shared/strata'
import { modelLine, phaseLine, replyLine, statusLine, taskLine } from '../summary/format'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'
import { machineState, stateWords } from './link'
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

// The kit's own note and browser cards stand for the two kinds wherever a label needs a mark.
function KindMark({ kind }: { kind: 'notes' | 'browsers' }) {
  const env = useLevels()
  return <Figure art={env.kit.attachment({ kind: kind === 'notes' ? 'note' : 'browser', shared: false })} className="kind-mark" />
}

function Panel({ kind, tabs, initial, rect }: { kind: 'notes' | 'browsers'; tabs: Tab[]; initial?: string; rect?: { x: number; y: number; w: number; h: number } }) {
  const [active, setActive] = useState(() => tabs.find((t) => t.id === initial)?.id ?? tabs[0]?.id)
  const current = tabs.find((t) => t.id === active) ?? tabs[0]
  return (
    <section className={`side-panel ${kind}`} style={rect ? rectStyle(rect) : undefined} aria-label={kind === 'notes' ? 'Notes' : 'Browsers'}>
      <div className="tabs" role="tablist" data-stage-gestures="off">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === current?.id} className="tab" title={t.title} onClick={() => setActive(t.id)}>
            <KindMark kind={kind} />
            <span className="tab-title">{t.title}</span>
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
  const terminalAnchor = env.useAnchor('terminal')
  const live = machine?.link === 'live'
  const load = useAgentDetail(machine?.base, agent?.id, live)
  // A dive from a fan card or +N opens the drawer (sheet on a phone) on its list.
  const [drawer, setDrawer] = useState<'notes' | 'browsers' | null>(env.goOptions.attachmentId || env.goOptions.allAttachments ? 'notes' : null)
  if (!machine || !workspace || !agent) return <div className="level level-plate">This agent is not here any more.</div>

  const detail = load.state === 'ready' ? load.detail : null
  const notes: Tab[] = detail ? detail.notes.map((n) => ({ id: n.id, title: n.title, body: n.content })) : agent.attachments.filter((a) => a.kind === 'note').map((a) => ({ id: a.id, title: a.title, body: '(last known title only)' }))
  const browsers: Tab[] = detail
    ? detail.browsers.map((b) => ({ id: b.id, title: b.title, sub: `${b.url ?? 'no address'}${b.live ? '' : ' · not running'}`, body: b.tabs.map((t) => t.url).join('\n') || '(no tabs)' }))
    : agent.attachments.filter((a) => a.kind === 'browser').map((a) => ({ id: a.id, title: a.title, sub: a.host ?? undefined, body: '(last known address only)' }))
  const focusId = env.goOptions.attachmentId
  const phase = phaseLine(agent, Date.now(), !live)

  const state = machineState(machine)
  const why =
    state === 'outdated'
      ? `  ${machine.name} runs a Cookrew without levels.\n  Its classic view opens this agent instead.`
      : live
        ? `  ${agent.name}'s own terminal opens here from ${machine.name}.\n  Until it does, this is the last thing we know.`
        : `  ${machine.name}: ${stateWords(machine, env.now())}.\n  The terminal opens when the machine is back.`
  const drawerItems = drawer === 'notes' ? notes : browsers
  const count = notes.length + browsers.length

  return (
    <div className="level level-terminal">
      <div ref={terminalAnchor} className="terminal-standin" style={rectStyle(layout.terminal)} role="region" aria-label={`${agent.name}'s terminal on ${machine.name}`}>
        <pre>{`╭─ ${agent.name} · ${modelLine(agent)}\n│ ${phase.label} · ${phase.elapsed} · ${phase.source}\n│ ${statusLine(agent, !live)}\n│ task   ${taskLine(agent)}\n│ reply  ${replyLine(agent)}\n╰─\n\n${why}`}</pre>
        {state === 'outdated' && (
          <a className="cta" href={machine.base} target="_blank" rel="noreferrer">
            Open the classic view
          </a>
        )}
      </div>
      {layout.edgeTabs &&
        (['notes', 'browsers'] as const).map((kind) => {
          const items = kind === 'notes' ? notes : browsers
          return items.length === 0 ? null : (
            <div key={kind} className={`edge-tabs ${kind}`} style={rectStyle(layout.edgeTabs![kind])} data-plane="screen" data-stage-gestures="off" role="tablist" aria-label={kind === 'notes' ? 'Notes' : 'Browsers'}>
              {items.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={drawer === kind} className="edge-tab" title={item.title} aria-label={`${kind === 'notes' ? 'Note' : 'Browser'}: ${item.title}`} onClick={() => setDrawer(drawer === kind ? null : kind)}>
                  <KindMark kind={kind} />
                </button>
              ))}
            </div>
          )
        })}
      {drawer && layout.drawer && (
        <div className="drawer" style={rectStyle(layout.drawer[drawer])} role="dialog" aria-label={drawer === 'notes' ? 'Notes' : 'Browsers'}>
          <button type="button" className="close" onClick={() => setDrawer(null)} aria-label="Close">
            ✕
          </button>
          <Panel key={drawer} kind={drawer} tabs={drawerItems} initial={focusId} />
        </div>
      )}
      {layout.sheet && count > 0 && (
        <button type="button" className="sheet-handle" data-plane="screen" onClick={() => setDrawer(drawer ? null : notes.length ? 'notes' : 'browsers')} aria-expanded={!!drawer}>
          <KindMark kind="notes" />
          {notes.length}
          <KindMark kind="browsers" />
          {browsers.length}
        </button>
      )}
      {layout.sheet && drawer && (
        <div className="sheet" role="dialog" aria-label="Notes and browsers">
          <div className="seg">
            <button type="button" aria-pressed={drawer === 'notes'} onClick={() => setDrawer('notes')}>
              Notes {notes.length}
            </button>
            <button type="button" aria-pressed={drawer === 'browsers'} onClick={() => setDrawer('browsers')}>
              Browsers {browsers.length}
            </button>
            <button type="button" className="close" onClick={() => setDrawer(null)} aria-label="Close">
              ✕
            </button>
          </div>
          <Panel key={drawer} kind={drawer} tabs={drawerItems} initial={focusId} />
        </div>
      )}
    </div>
  )
}
