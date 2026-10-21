import type { FleetMachine, FleetPresence } from '../src/shared/strata'
import type { FixtureMachine } from '../src/strata/fixture/synthetic'

export const LINKS_PER_ACCOUNT: number
export function desktopRows(machines: readonly FixtureMachine[], at: number): FleetMachine[]
export function presenceOf(machines: readonly FixtureMachine[], at: number, cap?: number): FleetPresence
