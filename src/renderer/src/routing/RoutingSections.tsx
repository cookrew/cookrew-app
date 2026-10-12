import { useState } from 'react'
import type { HarnessRow, RouteDecision, RouteModel, RouteQuota, RouteState } from '../../../shared/route'
import { KEY_PRESETS, ROUTING_COPY, decisionFacts, harnessTicks, quotaBar, routeChoices, statusLine, windowLabel, routeHead } from '../../../shared/route-view'
import { keyLineFor } from '../../../shared/route-lines'
import { runningLabel, type SetupRunning } from './setup-line-state'

/**
 * THE ROUTING PANEL'S SECTIONS. Each is a function of the route state and a
 * few callbacks; the words and the order come from shared/route-view.ts, so
 * the markup here is the picture and nothing else.
 */

export interface RunLine {
  (line: string, options?: { enter?: boolean }): void
}

export function StatusLine({ state, onRun, running = null }: { state: RouteState; onRun: RunLine; running?: SetupRunning | null }): React.JSX.Element {
  const line = statusLine(state)
  const busy = line.action !== null ? runningLabel(running, line.action.line) : null
  return (
    <div className={`cr-routing-status ${line.status}`} role="status">
      <span className="cr-routing-lamp" />
      <span className="big">Magpie</span>
      <span>{line.text}</span>
      {line.source !== null && <span className="cr-routing-source">{line.source}</span>}
      <span className="sp" />
      {line.action !== null && (
        <button type="button" className={`cr-routing-btn primary${busy ? ' running' : ''}`} title={line.action.line} disabled={busy !== null} onClick={() => onRun(line.action!.line)}>
          {busy ?? `${line.action.label} · ${line.action.line}`}
        </button>
      )}
    </div>
  )
}

export function Harnesses({
  rows,
  onRun,
  onAddToDock,
  running = null
}: {
  rows: readonly HarnessRow[]
  onRun: RunLine
  onAddToDock?: (harness: HarnessRow) => void
  running?: SetupRunning | null
}): React.JSX.Element {
  return (
    <>
      <div className="cr-routing-seg">
        Harnesses <span className="k3">installed · signed in · in dock · routes — a missing tick is the button</span>
        <span className="sp" />
      </div>
      {rows.map((row) => (
        <div className="cr-routing-hrow" key={row.id} data-harness={row.id}>
          <span className="n">{row.name}</span>
          {harnessTicks(row).map((tick) => {
            if (tick.ok) {
              return (
                <span key={tick.label} className="cr-routing-tick ok">
                  ✓ {tick.label}
                </span>
              )
            }
            if (tick.line !== null) {
              const busy = runningLabel(running, tick.line)
              return (
                <button key={tick.label} type="button" className={`cr-routing-tick btn${busy ? ' running' : ''}`} title={tick.line} disabled={busy !== null} onClick={() => onRun(tick.line!)}>
                  {busy ?? `${tick.label === 'installed' ? 'install' : 'sign in'} · ${tick.line}`}
                </button>
              )
            }
            if (tick.why) {
              // Nothing to type and nothing to click: the reason is the title, the same sentence the card's RTE dial reads.
              return (
                <span key={tick.label} className="cr-routing-tick bad" title={tick.why}>
                  ✗ {tick.label}
                </span>
              )
            }
            if (tick.act === 'dock' && onAddToDock) {
              return (
                <button key={tick.label} type="button" className="cr-routing-tick btn" onClick={() => onAddToDock(row)}>
                  add to dock
                </button>
              )
            }
            return (
              <span key={tick.label} className="cr-routing-tick dim">
                — {tick.label}
              </span>
            )
          })}
          <span className="small">{row.id === 'claude' || row.id === 'codex' || row.id === 'opencode' || row.id === 'pi' ? 'full rail' : ''}</span>
        </div>
      ))}
    </>
  )
}

function Quota({ q }: { q: RouteQuota }): React.JSX.Element {
  const bar = quotaBar(q)
  return (
    <div className="cr-routing-arow">
      <span>
        <b>{bar.title}</b>
        <br />
        <span className="small">{bar.sub || bar.kind}</span>
      </span>
      {bar.error !== null ? (
        // The gateway could not read this one: the sentence, no bar.
        <span className="cr-routing-bad" style={{ padding: 0 }}>
          {bar.error}
        </span>
      ) : bar.fill === null ? (
        <span className="small">{bar.reading}</span>
      ) : (
        <span className="cr-routing-quota">
          <span className="l">
            {/* The fullest window names the bar; its label is the gateway's own. */}
            <span>{bar.reading.slice(0, bar.reading.indexOf(' '))}</span>
            <span>{bar.reading.slice(bar.reading.indexOf(' ') + 1)}</span>
          </span>
          <span className="b">
            <i className={bar.hot ? 'hot' : ''} style={{ width: `${Math.round(bar.fill * 100)}%` }} />
          </span>
        </span>
      )}
      <span className="small ws">{bar.error === null && q.windows.length > 1 ? `${q.windows[1].name} ${windowLabel(q.windows[1])}` : ''}</span>
      <span className={`cr-routing-tick ${bar.error !== null ? 'dim' : 'ok'}`}>{q.kind}</span>
    </div>
  )
}

export function AddMenu({ setup, onRun, defaultOpen = false, running = null }: { setup: RouteState['setup']; onRun: RunLine; defaultOpen?: boolean; running?: SetupRunning | null }): React.JSX.Element {
  const busyFor = (line: string | null): string | null => (line === null ? null : runningLabel(running, line))
  const [open, setOpen] = useState(defaultOpen)
  const [keys, setKeys] = useState(false)
  const [unexpected, setUnexpected] = useState(false)
  const toggle = (): void => {
    setOpen((o) => !o)
    setKeys(false)
    // The notice is about the last click on the open menu; a new opening starts clean.
    setUnexpected(false)
  }
  const run = (line: string, enter = true): void => {
    setOpen(false)
    setKeys(false)
    onRun(line, { enter })
  }
  // Only `magpie provider add ` + preset is ever typed; a stem of another
  // shape means main changed the line and the renderer refuses to guess.
  const runKey = (preset: string): void => {
    const line = keyLineFor(setup.addKeyLine, preset)
    if (line === null) {
      setUnexpected(true)
      setOpen(false)
      setKeys(false)
      return
    }
    setUnexpected(false)
    run(line, false)
  }
  return (
    <span className="cr-routing-add">
      {unexpected && <span className="cr-routing-bad">setup line unexpected — nothing typed</span>}{' '}

      <button type="button" className="cr-routing-btn primary" aria-expanded={open} onClick={toggle}>
        {ROUTING_COPY.add} ▾
      </button>
      {open && (
        <div className="cr-routing-menu" role="menu">
          <button type="button" role="menuitem" disabled={busyFor(setup.addSubscriptionLine) !== null} onClick={() => run(setup.addSubscriptionLine)}>
            <b>{ROUTING_COPY.addSubscription}</b>
            <span className="c">{busyFor(setup.addSubscriptionLine) ?? `${setup.addSubscriptionLine} · claude login · gemini auth`}</span>
          </button>
          <button type="button" role="menuitem" aria-expanded={keys} onClick={() => setKeys((k) => !k)}>
            <b>{ROUTING_COPY.addKey}</b>
            <span className="c">
              {setup.addKeyLine}‹key› — {ROUTING_COPY.keyHint}
            </span>
          </button>
          {keys && (
            <div className="cr-routing-presets">
              {KEY_PRESETS.map((preset) => (
                <button key={preset} type="button" className="cr-routing-pick" data-preset={preset} onClick={() => runKey(preset)}>
                  {preset}
                </button>
              ))}
            </div>
          )}
          <button type="button" role="menuitem" disabled={busyFor(setup.addLocalLine) !== null} onClick={() => run(setup.addLocalLine)}>
            <b>{ROUTING_COPY.addLocal}</b>
            <span className="c">{busyFor(setup.addLocalLine) ?? setup.addLocalLine}</span>
          </button>
          {/* Main sends the group line only with two catalogue models filled in — never a placeholder; below two there is nothing to type. */}
          <button type="button" role="menuitem" disabled={setup.addGroupLine === null || busyFor(setup.addGroupLine) !== null} onClick={() => setup.addGroupLine !== null && run(setup.addGroupLine)}>
            <b>{ROUTING_COPY.addGroup}</b>
            <span className="c">{busyFor(setup.addGroupLine) ?? setup.addGroupLine ?? ROUTING_COPY.groupNeedsTwo}</span>
          </button>
        </div>
      )}
    </span>
  )
}

export function Accounts({
  state,
  onRun,
  onSetDefault,
  running = null
}: {
  state: RouteState
  onRun: RunLine
  onSetDefault: (model: string | null) => void
  running?: SetupRunning | null
}): React.JSX.Element {
  if (state.status !== 'online') {
    return (
      <>
        <div className="cr-routing-seg">Models &amp; accounts</div>
        <div className="cr-routing-empty">
          <b>NO GATEWAY</b>
          {ROUTING_COPY.noGateway}
        </div>
      </>
    )
  }
  const choices = routeChoices(state.models)
  return (
    <>
      <div className="cr-routing-seg">
        Models &amp; accounts <span className="sp" />
        <AddMenu setup={state.setup} onRun={onRun} running={running} />
      </div>
      {state.quotas.map((q) => (
        <Quota key={`${q.provider}:${q.account ?? ''}`} q={q} />
      ))}
      <div className="cr-routing-default" role="radiogroup" aria-label="Default route for new cards">
        <span className="cr-routing-seg" style={{ margin: 0 }}>
          {ROUTING_COPY.defaultLabel}
        </span>
        {state.defaultModel === null && <span className="small">{ROUTING_COPY.defaultNone}</span>}
        {choices.map((id) => {
          const on = id === 'direct' ? state.defaultModel === null : state.defaultModel === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`cr-routing-pick${on ? ' on' : ''}`}
              onClick={() => onSetDefault(id === 'direct' ? null : id)}
            >
              {id}
            </button>
          )
        })}
      </div>
      <details className="cr-routing-fold">
        <summary>▸ Model catalogue · {state.models.length} · /v1/models</summary>
        <div>
          {state.models.map((m) => (
            <ModelLine key={m.id} m={m} />
          ))}
        </div>
      </details>
    </>
  )
}

function ModelLine({ m }: { m: RouteModel }): React.JSX.Element {
  return (
    <div className="cr-routing-model">
      <span>{m.id}</span>
      <span className="t">{m.group ? 'routing group' : m.ownedBy}</span>
      <span className="t">{m.reasoning ? m.levels.join(' · ') || 'reasoning' : '—'}</span>
      <span className="t">{m.contextWindow === null ? '—' : `${Math.round(m.contextWindow / 1000)}k`}</span>
    </div>
  )
}

export function LiveRoutes({
  state,
  names,
  onZoom
}: {
  state: RouteState
  names: ReadonlyMap<string, string>
  onZoom?: (terminalId: string) => void
}): React.JSX.Element | null {
  if (state.status === 'absent') return null
  if (state.status === 'offline' || state.live.length === 0) {
    return (
      <>
        <div className="cr-routing-seg">Live routes</div>
        <div className="small" style={{ padding: '4px 8px' }}>
          {state.status === 'offline' ? 'gateway offline — cards run direct until it is back' : 'no routed turn yet'}
        </div>
      </>
    )
  }
  return (
    <>
      <div className="cr-routing-seg">
        Live routes <span className="k3">last {Math.min(state.live.length, 6)} · /v1/magpie/route?session= · click a row to zoom the card</span>
      </div>
      {state.live.slice(0, 6).map((d) => (
        <LiveRow key={`${d.terminalId}:${d.seq}`} d={d} name={names.get(d.terminalId) ?? d.terminalId} onZoom={onZoom} />
      ))}
    </>
  )
}

function LiveRow({ d, name, onZoom }: { d: RouteDecision; name: string; onZoom?: (terminalId: string) => void }): React.JSX.Element {
  const at = new Date(d.at)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const ss = String(at.getSeconds()).padStart(2, '0')
  const alt = decisionFacts(d)
  return (
    <button type="button" className="cr-routing-lrow" onClick={() => onZoom?.(d.terminalId)}>
      <span className="t">{`${hh}:${mm}:${ss}`}</span>
      <span>{name}</span>
      <span className="arr">→</span>
      <span className="g">{routeHead(d)}</span>
      <span className="arr">→</span>
      <span className="m">{d.model ?? '—'}</span>
      <span className="alt">{alt}</span>
    </button>
  )
}

export function Rented({ state }: { state: RouteState }): React.JSX.Element | null {
  if (state.status === 'absent') return null
  return (
    <>
      <div className="cr-routing-seg">Rented sessions</div>
      <div className="cr-routing-arow" style={{ gridTemplateColumns: '1fr auto' }}>
        <span>
          <b>{ROUTING_COPY.rented}</b>
          <br />
          <span className="small">a served session never gets this machine's route; lending a budget is the next round</span>
        </span>
        <span className="cr-routing-tick dim">read-only</span>
      </div>
    </>
  )
}
