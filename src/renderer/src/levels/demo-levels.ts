// The browser demo's levels: the first machine of the Strata preview's
// synthetic fleet, loaded lazily so the fixture never ships in the app's
// first chunk. Its agents open the demo's simulated shell like any card.
import type { LevelsAgentDetail, LevelsSnapshot } from '../../../shared/strata'

let snapshot: Promise<LevelsSnapshot | null> | null = null

export const demoLevelsSnapshot = (): Promise<LevelsSnapshot | null> => {
  snapshot ??= import('../../../strata/fixture/synthetic').then(
    ({ syntheticFleet }) => syntheticFleet(Date.now()).find((m) => m.levels !== null)?.levels ?? null
  )
  return snapshot
}

export const demoLevelsDetail = async (agentId: string): Promise<LevelsAgentDetail | null> => {
  const levels = await demoLevelsSnapshot()
  for (const workspace of levels?.workspaces ?? []) {
    const agent = workspace.agents.find((a) => a.id === agentId)
    if (agent) return { agent, workspaceId: workspace.id, notes: [], browsers: [] }
  }
  return null
}
