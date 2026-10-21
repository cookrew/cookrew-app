// "8 of N online" (D6): the relay holds at most ONLINE_CAP desktop lines per
// account, so with more machines than that some are offline by the cap, not
// by being switched off. The registry's `online` is the line; `live` is this
// page's own stream, which can lag it by a reconnect.
import type { StrataMachine } from '../../shared/strata'
import { ONLINE_CAP } from './fleet-store'

export interface OnlinePicture {
  total: number
  online: number
  live: number
  cap: number
  /** Every line the account may hold is taken while machines wait offline. */
  capped: boolean
  /** '3 of 5 online', '8 of 11 online'. */
  label: string
}

export const onlinePicture = (machines: readonly StrataMachine[], cap = ONLINE_CAP): OnlinePicture => {
  const online = machines.filter((m) => m.online).length
  const live = machines.filter((m) => m.link === 'live').length
  return {
    total: machines.length,
    online,
    live,
    cap,
    capped: online >= cap && machines.length > online,
    label: `${online} of ${machines.length} online`
  }
}
