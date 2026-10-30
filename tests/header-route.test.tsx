// THE ONE BAR (2026-10-29): the route device / workspace / agent on the left,
// the function bar and ⋯ on the right. A zoomed terminal keeps its own head;
// the route only names it.
import { describe, expect, it } from 'vitest'
import { routeAgent, routeSteps, stageRouteState } from '../src/renderer/src/HeaderRoute'
import {
  createLevelsRoute,
  LEVELS_DEVICE_KEY,
  LEVELS_PATH_KEY,
  namesOf,
  WORKSPACES_PATH,
  type LevelsRouteState
} from '../src/renderer/src/levels/levels-history'
import { LOCAL_MACHINE_ID, localMachine } from '../src/renderer/src/levels/local-fleet'
import { syntheticFleet } from '../src/strata/fixture/synthetic'

const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value)
  }
}

describe('the levels path, shared by the levels and the route', () => {
  it('opens where it was left, and remembers every move', () => {
    const storage = memory({ [LEVELS_PATH_KEY]: JSON.stringify({ machine: 'm', workspace: 'w' }) })
    const route = createLevelsRoute(storage)
    expect(route.get().path).toEqual({ machine: 'm', workspace: 'w' })
    route.go({ machine: 'm', workspace: 'w', agent: 'a' })
    expect(JSON.parse(storage.data.get(LEVELS_PATH_KEY) ?? '')).toEqual({ machine: 'm', workspace: 'w', agent: 'a' })
    route.out()
    expect(route.get().path).toEqual({ machine: 'm', workspace: 'w' })
  })

  it('does not publish a move to where it already is', () => {
    const route = createLevelsRoute(memory())
    let told = 0
    route.subscribe(() => (told += 1))
    route.go(route.get().path)
    expect(told).toBe(0)
    route.go(WORKSPACES_PATH)
    route.go({})
    expect(told).toBe(1)
  })

  it('keeps the device name for the views that have no fleet', () => {
    const storage = memory()
    const route = createLevelsRoute(storage)
    route.name({ machine: 'MacBook Pro', workspace: null, agent: null })
    expect(storage.data.get(LEVELS_DEVICE_KEY)).toBe('MacBook Pro')
    expect(createLevelsRoute(storage).get().names.machine).toBe('MacBook Pro')
  })

  it('asks the shell for its finder by a counter', () => {
    const route = createLevelsRoute(memory())
    route.requestFind()
    route.requestFind()
    expect(route.get().find).toBe(2)
  })

  it('names the steps the way the fleet spells them', () => {
    const levels = syntheticFleet(1_800_000_000_000).find((m) => m.levels !== null)?.levels
    if (!levels) throw new Error('the synthetic fleet has no machine with levels')
    const fleet = [localMachine(levels, 'live')]
    const ws = levels.workspaces[0]
    expect(namesOf({ machine: LOCAL_MACHINE_ID, workspace: ws.id }, fleet)).toEqual({
      machine: levels.machine.name,
      workspace: { name: ws.name, icon: ws.icon },
      agent: null
    })
    const seated = levels.workspaces.find((w) => w.agents.length > 0)
    if (!seated) throw new Error('the synthetic machine has no seated workspace')
    expect(namesOf({ machine: LOCAL_MACHINE_ID, workspace: seated.id, agent: seated.agents[0].id }, fleet).agent).toBe(seated.agents[0].name)
    // Still connecting: no name yet, rather than "This desktop" remembered as one.
    expect(namesOf({}, [localMachine(null, 'connecting')]).machine).toBeNull()
  })
})

describe('the route', () => {
  const state = (path: LevelsRouteState['path']): LevelsRouteState => ({
    path,
    names: { machine: 'MacBook Pro', workspace: { name: 'Velvet', icon: '🎨' }, agent: 'Street' },
    find: 0
  })
  const canvasWorkspace = { name: 'Cookrew Dev', icon: '🍳', dir: '/w/cookrew' }
  const steps = (inLevels: boolean, path: LevelsRouteState['path'] = {}) =>
    routeSteps({ inLevels, levels: state(path), canvasWorkspace, device: 'MacBook Pro' })

  it('on the canvas: this desktop / the canvas workspace, neither of them "here"', () => {
    const [device, workspace] = steps(false)
    expect(device).toMatchObject({ key: 'device', label: 'MacBook Pro', current: false, to: {} })
    expect(workspace).toMatchObject({ key: 'workspace', label: 'Cookrew Dev', emoji: '🍳', current: false })
  })

  it('the workspace step always lands on the workspace choice', () => {
    expect(steps(false)[1].to).toEqual(WORKSPACES_PATH)
    expect(steps(true, { machine: LOCAL_MACHINE_ID, workspace: 'w' })[1].to).toEqual(WORKSPACES_PATH)
    expect(steps(true, { machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' })[1].to).toEqual(WORKSPACES_PATH)
  })

  it('in the levels it follows their path, and marks where you are', () => {
    expect(steps(true, {})).toEqual([expect.objectContaining({ label: 'Devices', current: true })])
    expect(steps(true, { machine: LOCAL_MACHINE_ID })).toEqual([expect.objectContaining({ label: 'MacBook Pro', current: true })])
    const atAgents = steps(true, { machine: LOCAL_MACHINE_ID, workspace: 'w' })
    expect(atAgents.map((s) => [s.label, s.current])).toEqual([
      ['MacBook Pro', false],
      ['Velvet', true]
    ])
    // At a terminal the agent's own step (the slot) is where you are.
    expect(steps(true, { machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' }).some((s) => s.current)).toBe(false)
  })
})

describe('the agent step', () => {
  const state = (path: LevelsRouteState['path'], agent: string | null = 'Street'): LevelsRouteState => ({
    path,
    names: { machine: 'MacBook Pro', workspace: { name: 'Velvet', icon: '🎨' }, agent },
    find: 0
  })

  it('on the canvas names the zoomed terminal, and nothing when none is', () => {
    expect(routeAgent(false, state({}), 'Conductor')).toBe('Conductor')
    expect(routeAgent(false, state({ machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' }), null)).toBeNull()
  })

  it('in the levels follows their path, not the canvas zoom', () => {
    expect(routeAgent(true, state({ machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' }), 'Conductor')).toBe('Street')
    expect(routeAgent(true, state({ machine: LOCAL_MACHINE_ID, workspace: 'w' }), 'Conductor')).toBeNull()
    // The fleet has not named it yet.
    expect(routeAgent(true, state({ machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' }, null), null)).toBe('…')
  })
})

describe('the stage route', () => {
  const ws = { name: 'Velvet', icon: '🎨' }
  const canvasWorkspace = { name: 'Velvet', icon: '🎨', dir: '/w' }
  const at = (level: 'devices' | 'workspaces' | 'workspace', zoomed: string | null = null) => {
    const levels = stageRouteState({ level, machine: 'MacBook Pro', workspace: ws, zoomed })
    return {
      steps: routeSteps({ inLevels: true, levels, canvasWorkspace, device: 'MacBook Pro' }).map((s) => `${s.label}${s.current ? '*' : ''}`),
      agent: routeAgent(true, levels, zoomed)
    }
  }
  it('says devices → device → device / workspace → device / workspace / card', () => {
    expect(at('devices')).toEqual({ steps: ['Devices*'], agent: null })
    expect(at('workspaces')).toEqual({ steps: ['MacBook Pro*'], agent: null })
    expect(at('workspace')).toEqual({ steps: ['MacBook Pro', 'Velvet*'], agent: null })
    expect(at('workspace', 'Street')).toEqual({ steps: ['MacBook Pro', 'Velvet'], agent: 'Street' })
  })
})
