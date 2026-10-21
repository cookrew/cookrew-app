// PROTOTYPE scenes for the four stops, drawn with the stand-in figures and
// registering the real anchors, so the stage can be reviewed before the
// levels and figures lanes land. Scenes are transparent: the paper is the
// stage's.
import type { CSSProperties, ReactNode } from 'react'
import type { AnchorId, FigureArt, LevelsAgent, LevelsWorkspace, Rect, StrataMachine, StrataPath } from '../../../shared/strata'
import { standInFigures as kit } from '../../stand-in/figures'
import { useAnchor } from '../anchors'
import { pathKey } from '../plan'
import { highlightOf, setHighlight } from './highlight'
import { agentsLayout, machinesLayout, placeAnchor, terminalLayout, workspacesLayout, type Viewport } from './layout'

export interface SceneProps {
  machines: StrataMachine[]
  v: Viewport
  go: (path: StrataPath) => void
}

const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h })

function Fig({ art, rect, className }: { art: FigureArt; rect: Rect; className?: string }) {
  return <div className={`fig ${className ?? ''}`} style={box(rect)} dangerouslySetInnerHTML={{ __html: art.svg }} />
}

/** A pickable item: registers its anchor, carries the level's highlight. */
function Item(props: { anchor: AnchorId; level: StrataPath; id: string; first: boolean; rect: Rect; label: string; className?: string; onPick: () => void; children?: ReactNode }) {
  const ref = useAnchor(props.anchor)
  const levelKey = pathKey(props.level)
  const lit = (highlightOf(levelKey) ?? (props.first ? props.id : undefined)) === props.id
  return (
    <button
      ref={ref}
      className={`item ${props.className ?? ''}`}
      style={box(props.rect)}
      aria-label={props.label}
      data-hl-level={levelKey}
      data-hl-id={props.id}
      data-hl={lit ? '' : undefined}
      data-stage-focus={lit ? '' : undefined}
      onPointerEnter={(e) => setHighlight(levelKey, props.id, e.currentTarget)}
      onFocus={(e) => setHighlight(levelKey, props.id, e.currentTarget)}
      onClick={props.onPick}
    >
      {props.children}
    </button>
  )
}

function Anchor({ id, rect, className, children }: { id: AnchorId; rect: Rect; className?: string; children?: ReactNode }) {
  const ref = useAnchor(id)
  return (
    <div ref={ref} className={className} style={{ position: 'absolute', ...box(rect) }}>
      {children}
    </div>
  )
}

// ── level 0 ─────────────────────────────────────────────────────────────────

const MACHINE_ART = kit.machine({ kind: 'desktop', link: 'live' })
const ASPECT = MACHINE_ART.viewBox.w / MACHINE_ART.viewBox.h

export function MachinesScene({ machines, v, go }: SceneProps) {
  const rects = machinesLayout(machines.length, ASPECT, v)
  return (
    <div className="level" style={{ height: Math.max(v.h, ...rects.map((r) => r.y + r.h + 60)) }}>
      {machines.map((m, i) => {
        const art = kit.machine({ kind: m.profile?.kind ?? 'unknown', link: m.link })
        const portal = placeAnchor(rects[i], art, art.anchors.portal)
        const waiting = (m.levels?.workspaces ?? []).flatMap((w) => w.agents.filter((a) => a.phase === 'waiting').map((a) => ({ w, a }))).slice(0, 3)
        return (
          <div key={m.id}>
            <Item anchor={`machine:${m.id}`} level={{}} id={m.id} first={i === 0} rect={rects[i]} label={`${m.name}, ${m.profile?.kind ?? 'unknown'}`} onPick={() => go({ machine: m.id })}>
              <Fig art={art} rect={{ x: 0, y: 0, w: rects[i].w, h: rects[i].h }} />
            </Item>
            <Anchor id={`portal:${m.id}`} rect={portal} className="portal">
              {m.levels && <Miniature machine={m} portal={portal} v={v} />}
            </Anchor>
            <div className="label" data-plane="screen" style={{ left: rects[i].x, top: rects[i].y + rects[i].h + 6, width: rects[i].w }}>
              <b>{m.name}</b> · {m.profile?.label ?? m.profile?.kind ?? 'unknown'} · {m.link}
            </div>
            {waiting.map(({ w, a }, j) => (
              <button
                key={a.id}
                className="pin"
                data-plane="screen"
                style={{ left: rects[i].x + rects[i].w - 18 - j * 30, top: rects[i].y - 12 }}
                title={`${a.name} is waiting: ${a.task ?? ''}`}
                aria-label={`Dive into ${a.name}, waiting`}
                onClick={() => go({ machine: m.id, workspace: w.id, agent: a.id })}
              >
                !
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** The workspaces level itself, laid out for this viewport and fitted into the screen. */
function Miniature({ machine, portal, v }: { machine: StrataMachine; portal: Rect; v: Viewport }) {
  const k = Math.min(portal.w / v.w, portal.h / v.h)
  const style: CSSProperties = { left: (portal.w - v.w * k) / 2, top: (portal.h - v.h * k) / 2, width: v.w, height: v.h, transform: `scale(${k})` }
  return (
    <div className="mini" style={style} aria-hidden="true">
      <WorkspacesBody machine={machine} v={v} mini />
    </div>
  )
}

// ── level 1 ─────────────────────────────────────────────────────────────────

const containerArt = (w: LevelsWorkspace) => kit.container({ name: w.name, slots: w.agents.length })

export function WorkspacesScene({ machine, v, go }: { machine: StrataMachine | undefined } & SceneProps) {
  if (!machine?.levels) return <Empty v={v} text={machine ? `${machine.name} was never reached: no workspaces to show` : 'No such machine'} />
  return <WorkspacesBody machine={machine} v={v} go={go} />
}

function WorkspacesBody({ machine, v, mini, go }: { machine: StrataMachine; v: Viewport; mini?: boolean; go?: SceneProps['go'] }) {
  const workspaces = machine.levels?.workspaces ?? []
  const arts = workspaces.map(containerArt)
  const rects = workspacesLayout(arts.map((a) => a.viewBox), v)
  return (
    <div className="level" style={{ height: Math.max(v.h, ...rects.map((r) => r.y + r.h + 40)) }}>
      {workspaces.map((w, i) => {
        const level = { machine: machine.id }
        const seats = w.agents.slice(0, arts[i].capacity).map((a, j) => ({ a, r: placeAnchor(rects[i], arts[i], arts[i].anchors[`slot:${j}`]) }))
        const avatars = seats.map(({ a, r }) =>
          mini || !go ? (
            <Fig key={a.id} art={avatarArt(a, 'small')} rect={r} />
          ) : (
            <AvatarPick key={a.id} agent={a} rect={r} size="small" onPick={() => go({ machine: machine.id, workspace: w.id, agent: a.id })} />
          )
        )
        if (mini || !go) {
          return (
            <div key={w.id}>
              <Fig art={arts[i]} rect={rects[i]} />
              {avatars}
            </div>
          )
        }
        return (
          <div key={w.id}>
            <Item anchor={`workspace:${w.id}`} level={level} id={w.id} first={i === 0} rect={rects[i]} label={`${w.name}, ${w.agents.length} agents`} className="container" onPick={() => go({ machine: machine.id, workspace: w.id })}>
              <Fig art={arts[i]} rect={{ x: 0, y: 0, w: rects[i].w, h: rects[i].h }} />
            </Item>
            {avatars}
            <div className="label small" data-plane="screen" style={{ left: rects[i].x, top: rects[i].y + rects[i].h + 4, width: rects[i].w }}>
              {w.state} · {w.counts.agents} agents · {w.counts.notes} notes · {w.counts.browsers} browsers
            </div>
          </div>
        )
      })}
    </div>
  )
}

const avatarArt = (a: LevelsAgent, size: 'small' | 'full') => kit.avatar({ phase: a.phase, source: a.phaseSource, harness: a.harness, size })

function AvatarPick({ agent, rect, size, onPick }: { agent: LevelsAgent; rect: Rect; size: 'small' | 'full'; onPick: () => void }) {
  const ref = useAnchor(`agent:${agent.id}`)
  return (
    <button ref={ref} className="avatar" style={box(rect)} aria-label={`${agent.name}, ${agent.phase}: dive into its terminal`} title={[agent.name, agent.task].filter(Boolean).join(' · ')} onClick={onPick}>
      <span className="fig" dangerouslySetInnerHTML={{ __html: avatarArt(agent, size).svg }} />
    </button>
  )
}

// ── level 2 ─────────────────────────────────────────────────────────────────

export function AgentsScene({ machine, workspace, v, go }: { machine: StrataMachine | undefined; workspace: LevelsWorkspace | undefined } & SceneProps) {
  if (!machine || !workspace) return <Empty v={v} text="No such workspace" />
  const art = containerArt(workspace)
  const rect = agentsLayout(art.viewBox, v)
  const level = { machine: machine.id, workspace: workspace.id }
  const seats = workspace.agents.slice(0, art.capacity).map((a, j) => ({ a, r: placeAnchor(rect, art, art.anchors[`slot:${j}`]) }))
  const named = seats[0] ? seats[0].r.w >= 44 : false
  return (
    <div className="level">
      <Anchor id={`workspace:${workspace.id}`} rect={rect}>
        <Fig art={art} rect={{ x: 0, y: 0, w: rect.w, h: rect.h }} />
      </Anchor>
      {seats.map(({ a, r }, j) => (
        <div key={a.id}>
          <Item anchor={`agent:${a.id}`} level={level} id={a.id} first={j === 0} rect={r} label={`${a.name}, ${a.phase}`} className="avatar" onPick={() => go({ ...level, agent: a.id })}>
            <span className="fig" dangerouslySetInnerHTML={{ __html: avatarArt(a, 'full').svg }} />
          </Item>
          {named && (
            <div className="label tiny" data-plane="screen" style={{ left: r.x - 12, top: r.y + r.h, width: r.w + 24 }}>
              {a.name}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── level 3 ─────────────────────────────────────────────────────────────────

export function TerminalScene({ machine, workspace, agent, v }: { machine: StrataMachine | undefined; workspace: LevelsWorkspace | undefined; agent: LevelsAgent | undefined } & Pick<SceneProps, 'v'>) {
  const lay = terminalLayout(v)
  const ref = useAnchor('terminal')
  if (!machine || !workspace || !agent) return <Empty v={v} text="No such agent" />
  const notes = agent.attachments.filter((a) => a.kind === 'note')
  const browsers = agent.attachments.filter((a) => a.kind === 'browser')
  return (
    <div className="level">
      <div ref={ref} className="terminal" style={box(lay.terminal)} tabIndex={0} data-stage-gestures="off" aria-label={`Terminal of ${agent.name}`}>
        <div className="term-bar">
          {agent.name} · {agent.harness}
          {agent.model ? ` · ${agent.model}` : ''} · {machine.name} / {workspace.name}
        </div>
        <pre>
          {`› ${agent.task ?? '(no task line)'}\n\n${agent.reply ? `⏺ ${agent.reply}\n\n` : ''}${agent.status ? `✻ ${agent.status}\n` : ''}${agent.phase === 'waiting' ? '? waiting on you\n' : ''}\n╭────────────────────────────────╮\n│ >                              │\n╰────────────────────────────────╯\n\n(the companion's terminal embeds here, untouched)`}
        </pre>
      </div>
      {lay.notes && <Side rect={lay.notes} title="Notes" items={notes.map((n) => ({ id: n.id, title: n.title, sub: n.shared ? 'shared' : 'note' }))} />}
      {lay.browsers && <Side rect={lay.browsers} title="Browsers" items={browsers.map((b) => ({ id: b.id, title: b.title, sub: `${b.host ?? ''} · ${b.tabs ?? 1} tabs` }))} />}
      {lay.strip && (
        <div className="strip" style={box(lay.strip)} data-stage-gestures="off">
          {[...notes, ...browsers].map((a) => (
            <span key={a.id} className={`chip ${a.kind}`}>
              {a.title}
            </span>
          ))}
          {notes.length + browsers.length === 0 && <span className="chip">no notes or browsers</span>}
        </div>
      )}
    </div>
  )
}

function Side({ rect, title, items }: { rect: Rect; title: string; items: Array<{ id: string; title: string; sub: string }> }) {
  return (
    <div className="side" style={box(rect)}>
      <div className="side-tabs" data-stage-gestures="off">
        {items.slice(0, 6).map((it, i) => (
          <span key={it.id} className={`tab ${i === 0 ? 'on' : ''}`}>
            {it.title}
          </span>
        ))}
      </div>
      <h4>
        {title} · {items.length}
      </h4>
      {items.slice(0, 8).map((it) => (
        <div key={it.id} className="card">
          <b>{it.title}</b>
          <span>{it.sub}</span>
        </div>
      ))}
    </div>
  )
}

function Empty({ v, text }: { v: Viewport; text: string }) {
  return (
    <div className="level">
      <p className="empty" style={{ top: v.h / 2 - 20 }}>
        {text}
      </p>
    </div>
  )
}
