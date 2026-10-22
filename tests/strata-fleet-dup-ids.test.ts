// Ids are unique only within a machine: the synthetic old laptop was restored
// from the studio's backup and carries the studio's workspace and agent ids.
// A hit on the laptop must never open the studio's agent.
import { describe, expect, it, vi } from 'vitest'
import type { ShellToEmbed, StrataMachine } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { createFleetIndex } from '../src/strata/fleet/fleet-index'
import { createEmbedPool, type FrameHandle } from '../src/strata/embed/embed-pool'
import type { MessageLike } from '../src/strata/embed/messages'

const ORIGIN = 'https://cookrew.dev'
const rows = (): StrataMachine[] =>
  syntheticFleet(1_800_000_000_000).map(({ levels, ...m }) => ({ ...m, base: `/m/${m.id}/`, link: 'live', online: true, levels, stale: false }))

describe('ids shared across machines', () => {
  const fleet = rows()
  const index = createFleetIndex(fleet)
  const laptop = fleet.find((m) => m.id === 'syn-laptop')!
  const shared = laptop.levels!.workspaces[0].agents[0]

  it('the fixture really reuses the studio’s ids on the laptop', () => {
    const studioIds = new Set(fleet.find((m) => m.id === 'syn-studio')!.levels!.workspaces.flatMap((w) => w.agents.map((a) => a.id)))
    expect(studioIds.has(shared.id)).toBe(true)
  })

  it('the index keeps both, told apart by machine, and near picks the user’s machine on a tie', () => {
    const hits = index.find(shared.name, 50).filter((h) => h.agentId === shared.id)
    expect(hits.map((h) => h.machineId).sort()).toEqual(['syn-laptop', 'syn-studio'])
    const nearLaptop = index.find(shared.name, 50, { machine: 'syn-laptop' }).filter((h) => h.agentId === shared.id)
    expect(nearLaptop[0].machineId).toBe('syn-laptop')
    const nearStudio = index.find(shared.name, 50, { machine: 'syn-studio' }).filter((h) => h.agentId === shared.id)
    expect(nearStudio[0].machineId).toBe('syn-studio')
  })

  it('a dive from the laptop hit loads the laptop’s document, and the studio’s ready cannot finish it', async () => {
    vi.useFakeTimers()
    const frames: Array<{ machineId: string; src: string; window: object; inbox: ShellToEmbed[] }> = []
    let deliver: (event: MessageLike) => void = () => {}
    const pool = createEmbedPool({
      origin: ORIGIN,
      createFrame: (machineId, src) => {
        const frame = { machineId, src, window: { machineId }, inbox: [] as ShellToEmbed[] }
        frames.push(frame)
        return { window: frame.window, show: () => {}, hide: () => {}, remove: () => {} } satisfies FrameHandle
      },
      post: () => {},
      listen: (run) => ((deliver = run), () => {}),
      machine: (id) => fleet.find((m) => m.id === id),
      embedUrl: (m, agentId) => `${m.base}?embed=agent&agent=${agentId}`,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      maxWarm: () => 3,
      onOut: () => {}
    })
    pool.prewarm('syn-studio')
    const hit = index.find(shared.name, 50).find((h) => h.machineId === 'syn-laptop' && h.agentId === shared.id)!
    const opened = pool.open({ machine: hit.machineId, workspace: hit.workspaceId, agent: hit.agentId })
    const laptopFrame = frames.find((f) => f.machineId === 'syn-laptop')!
    expect(laptopFrame.src).toBe(`/m/syn-laptop/?embed=agent&agent=${shared.id}`)
    const studioFrame = frames.find((f) => f.machineId === 'syn-studio')!
    deliver({ origin: ORIGIN, source: studioFrame.window, data: { type: 'strata:ready', agentId: shared.id } })
    expect(pool.getSnapshot().shown).toBeNull()
    deliver({ origin: ORIGIN, source: laptopFrame.window, data: { type: 'strata:ready', agentId: shared.id } })
    await opened
    expect(pool.getSnapshot().shown).toEqual({ machineId: 'syn-laptop', agentId: shared.id })
    vi.useRealTimers()
  })
})
