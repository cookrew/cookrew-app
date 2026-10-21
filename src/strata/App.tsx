// PREVIEW WIREFRAME of the four levels: plain lists, ids in the URL, no camera,
// no figures. It proves the contract and the mock end to end, and is replaced
// piece by piece: the levels (what each shows, input, URL slugs), the stage,
// the figures, the fleet store and the terminal embed.
import { useEffect, useState } from 'react'
import { levelOf, parentOf, type StrataMachine, type StrataPath } from '../shared/strata'
import { useFleet } from './fleet/use-fleet'

const pathFromUrl = (): StrataPath => {
  const [machine, workspace, agent] = location.pathname.replace(/^\/me\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  return { machine, workspace, agent }
}
const urlOf = (path: StrataPath): string =>
  ['/me', path.machine, path.workspace, path.agent].filter(Boolean).map((p, i) => (i === 0 ? p : encodeURIComponent(p as string))).join('/')

export function App() {
  const machines = useFleet()
  const [path, setPath] = useState<StrataPath>(pathFromUrl)

  const go = (next: StrataPath) => {
    history.pushState(null, '', urlOf(next))
    setPath(next)
  }

  useEffect(() => {
    const onPop = () => setPath(pathFromUrl())
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.key === 'Escape') && levelOf(path) !== 'machines') go(parentOf(path))
    }
    addEventListener('popstate', onPop)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('popstate', onPop)
      removeEventListener('keydown', onKey)
    }
  })

  const machine = machines.find((m) => m.id === path.machine)
  const workspace = machine?.levels?.workspaces.find((w) => w.id === path.workspace)
  const agent = workspace?.agents.find((a) => a.id === path.agent)

  return (
    <main style={{ font: '14px/1.5 ui-monospace, monospace', padding: 24 }}>
      <p>
        {levelOf(path)} · <a href={urlOf({})} onClick={(e) => (e.preventDefault(), go({}))}>machines</a>
        {machine && ` › ${machine.name}`}
        {workspace && ` › ${workspace.name}`}
        {agent && ` › ${agent.name}`}
      </p>
      {levelOf(path) === 'machines' && <MachineList machines={machines} onPick={(m) => go({ machine: m })} />}
      {levelOf(path) === 'workspaces' &&
        machine?.levels?.workspaces.map((w) => (
          <button key={w.id} style={{ display: 'block' }} onClick={() => go({ ...path, workspace: w.id })}>
            {w.name} · {w.state} · {w.agents.length} agents
          </button>
        ))}
      {levelOf(path) === 'agents' &&
        workspace?.agents.map((a) => (
          <button key={a.id} style={{ display: 'block' }} title={[a.task, a.reply].filter(Boolean).join('\n')} onClick={() => go({ ...path, agent: a.id })}>
            {a.name} · {a.harness} · {a.phase} · {a.attachments.length} attached
          </button>
        ))}
      {levelOf(path) === 'terminal' && <p>terminal of {agent?.name ?? path.agent} — the companion embed goes here</p>}
    </main>
  )
}

function MachineList({ machines, onPick }: { machines: StrataMachine[]; onPick: (id: string) => void }) {
  return (
    <>
      {machines.map((m) => (
        <button key={m.id} style={{ display: 'block' }} onClick={() => onPick(m.id)}>
          {m.name} · {m.profile?.kind ?? 'unknown'} · {m.link} · {m.levels?.workspaces.length ?? '–'} workspaces
        </button>
      ))}
    </>
  )
}
