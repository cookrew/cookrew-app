// THE STAGE'S TWO UPPER LEVELS: every device, then every workspace of the
// device as a thumbnail. A thumbnail is the workspace level in miniature —
// its browsers and notes on the left, its agents on the right, the card that
// needs you in the middle — so going in looks like what it promised.
//
// Read from the levels feed (local-fleet.ts), which covers every workspace,
// not only the loaded one. Mounted only on these two levels, so the feed is
// open only while they are on screen.
import { useEffect } from 'react'
import { cookrew, isRemoteMode } from '../api'
import { CrIcon } from '../icons'
import { levelsRoute, namesOf } from '../levels/levels-history'
import { LOCAL_MACHINE_ID, useLocalFleet, useLocalFleetLoaded } from '../levels/local-fleet'
import type { LevelsAgent, LevelsWorkspace, StrataMachine } from '../../../shared/strata'
import { stageLevel, stageSelect } from './stage-select'

const hostName = (name: string): string => name.replace(/\.local$/i, '')

/** The agent a workspace's middle would show: the newest one waiting on you, else the newest that finished. */
export function attentionOf(workspace: LevelsWorkspace): LevelsAgent | null {
  const newest = (phase: LevelsAgent['phase']): LevelsAgent | null =>
    workspace.agents.filter((a) => a.phase === phase).reduce<LevelsAgent | null>((best, a) => (best === null || (a.phaseSince ?? 0) > (best.phaseSince ?? 0) ? a : best), null)
  return newest('waiting') ?? newest('replied')
}

const waitingIn = (workspace: LevelsWorkspace): number => workspace.agents.filter((a) => a.phase === 'waiting').length

export function StageMap({ level, loadedWorkspaceId }: { level: 'devices' | 'workspaces'; loadedWorkspaceId: string | null }): React.JSX.Element {
  const fleet = useLocalFleet()
  const loaded = useLocalFleetLoaded()
  // The route names the device from here too, not only from the levels view.
  useEffect(() => {
    if (loaded) levelsRoute.name(namesOf({ machine: LOCAL_MACHINE_ID }, fleet))
  }, [loaded, fleet])
  return level === 'devices' ? <Devices fleet={fleet} loaded={loaded} /> : <Workspaces machine={fleet.find((m) => m.id === LOCAL_MACHINE_ID) ?? fleet[0] ?? null} loaded={loaded} loadedWorkspaceId={loadedWorkspaceId} />
}

function Devices({ fleet, loaded }: { fleet: readonly StrataMachine[]; loaded: boolean }): React.JSX.Element {
  return (
    <div className="stg-map" aria-label="Devices">
      <div className="stg-map-head">
        <span className="stg-map-title">Devices</span>
        <span className="stg-head-count">{fleet.length}</span>
      </div>
      <div className="stg-map-grid devices">
        {!loaded && <div className="stg-empty">Finding your devices…</div>}
        {fleet.map((m) => {
          const workspaces = m.levels?.workspaces ?? []
          const agents = workspaces.reduce((n, w) => n + w.agents.length, 0)
          const waiting = workspaces.reduce((n, w) => n + waitingIn(w), 0)
          return (
            <button key={m.id} type="button" className={`stg-tile device${waiting > 0 ? ' needs' : ''}`} onClick={() => stageLevel.set('workspaces')}>
              <span className="stg-tile-head">
                <span className={`stg-dot ${m.link}`} aria-hidden="true" />
                <CrIcon name="device" />
                <span className="stg-tile-name">{hostName(m.name)}</span>
              </span>
              <span className="stg-device-screens">
                {workspaces.slice(0, 6).map((w) => (
                  <span key={w.id} className={`stg-device-screen${waitingIn(w) > 0 ? ' needs' : ''}${w.state === 'focused' ? ' focused' : ''}`} title={w.name}>
                    {w.icon ?? '🗂'}
                  </span>
                ))}
                {workspaces.length > 6 && <span className="stg-more">+{workspaces.length - 6}</span>}
              </span>
              <span className="stg-tile-foot">
                {workspaces.length} workspaces · {agents} agents{waiting > 0 && <b> · {waiting} need you</b>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Workspaces({ machine, loaded, loadedWorkspaceId }: { machine: StrataMachine | null; loaded: boolean; loadedWorkspaceId: string | null }): React.JSX.Element {
  const workspaces = machine?.levels?.workspaces ?? []
  const open = (w: LevelsWorkspace): void => {
    stageSelect.clear()
    stageLevel.set('workspace')
    if (w.id !== loadedWorkspaceId) void cookrew().switchWorkspace(w.id).catch((error) => console.error('Workspace switch failed:', error))
  }
  return (
    <div className="stg-map" aria-label="Workspaces">
      <div className="stg-map-head">
        <span className="stg-map-title">{machine ? hostName(machine.name) : 'Workspaces'}</span>
        <span className="stg-head-count">{workspaces.length}</span>
      </div>
      <div className="stg-map-grid">
        {!loaded && <div className="stg-empty">Reading the workspaces…</div>}
        {loaded && workspaces.length === 0 && <div className="stg-empty">{isRemoteMode() ? 'This desktop has no workspaces to show.' : 'No workspaces yet.'}</div>}
        {workspaces.map((w) => (
          <WorkspaceThumb key={w.id} workspace={w} loaded={w.id === loadedWorkspaceId} onOpen={() => open(w)} />
        ))}
      </div>
    </div>
  )
}

/** The workspace level in miniature: items | the card that needs you | agents. */
function WorkspaceThumb({ workspace, loaded, onOpen }: { workspace: LevelsWorkspace; loaded: boolean; onOpen: () => void }): React.JSX.Element {
  const hot = attentionOf(workspace)
  const waiting = waitingIn(workspace)
  // Every browser and note once: the agents' own and the loose ones.
  const items = new Map<string, 'browser' | 'note'>()
  for (const a of workspace.agents) for (const att of a.attachments) items.set(att.id, att.kind)
  for (const att of workspace.loose) items.set(att.id, att.kind)
  const kinds = [...items.values()]
  return (
    <button type="button" className={`stg-tile workspace${waiting > 0 ? ' needs' : ''}${loaded ? ' loaded' : ''}`} onClick={onOpen} title={`Open ${workspace.name}`}>
      <span className="stg-tile-head">
        <span className="stg-tile-emoji">{workspace.icon ?? '🗂'}</span>
        <span className="stg-tile-name">{workspace.name}</span>
        {loaded && <span className="stg-tag">open</span>}
      </span>
      <span className="stg-thumb" aria-hidden="true">
        <span className="stg-thumb-col items">
          {kinds.slice(0, 7).map((k, i) => (
            <i key={i} className={k} />
          ))}
        </span>
        <span className={`stg-thumb-mid${hot ? ` ${hot.phase}` : ''}`}>
          {hot ? (
            <>
              <b>{hot.name}</b>
              <span>{hot.phase === 'waiting' ? 'needs you' : 'finished'}</span>
              {hot.task && <em>{hot.task}</em>}
            </>
          ) : (
            <span>nothing needs you</span>
          )}
        </span>
        <span className="stg-thumb-col agents">
          {workspace.agents.slice(0, 12).map((a) => (
            <i key={a.id} className={`${a.phase}${a.id === hot?.id ? ' hot' : ''}`} />
          ))}
        </span>
      </span>
      <span className="stg-tile-foot">
        {workspace.counts.browsers + workspace.counts.notes} browsers & notes · {workspace.counts.agents} agents
        {waiting > 0 && <b> · {waiting} need you</b>}
      </span>
    </button>
  )
}
