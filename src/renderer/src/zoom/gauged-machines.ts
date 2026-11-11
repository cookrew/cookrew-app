import { machineOutdated } from '../../../shared/machine-version'

/**
 * WHOSE GAUGES THE DEVICES STOP READS (MachineGauges.tsx): the account's other
 * machines. On the console one below the floor (shared/machine-version.ts) gets
 * no line at all, because reading a machine's gauges is asking that machine,
 * through its door, and an old one is asked nothing.
 */
export function gaugedMachines<M extends { readonly local: boolean; readonly appVersion?: string | null }>(machines: readonly M[], floor: boolean): M[] {
  return machines.filter((machine) => !machine.local && !(floor && machineOutdated(machine.appVersion)))
}
