import { useSyncExternalStore } from 'react'
import { scopeEpoch, subscribeMachineScope } from './machine-scope'

const subscribe = (listener: () => void): (() => void) => subscribeMachineScope(() => listener())

/**
 * A number that changes each time another machine is entered. A view keyed by
 * it is remounted for the machine it now shows: its effects unsubscribe from
 * the last machine's stream and subscribe to the next one's, and its own state
 * starts clean. Constant on the desktop and on a machine's own page.
 */
export const useMachineScopeEpoch = (): number => useSyncExternalStore(subscribe, scopeEpoch, scopeEpoch)
