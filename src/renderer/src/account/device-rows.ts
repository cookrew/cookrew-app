import type { AccountDevice, AdmittedPhone } from '../../../shared/account-v2'

/**
 * ONE ROW PER DEVICE on the Devices tab.
 *
 * Three sources say a device exists: the account's list (cookrew.dev), the
 * devices THIS machine has admitted (admitted-devices.ts), and the watch paired
 * with this machine. Admission keys a row by the device's ACCOUNT id
 * (account-pair.ts admits `asking.deviceId`, the id the registry lists), so a
 * phone that is both on the account and admitted here is one device and gets
 * one row — the account's, marked `admittedHere`: its REVOKE ends the admission
 * here as well (account-ipc.ts), and FORGET HERE ends only that. A device this
 * machine knows and the account does not keeps a row of its own, with FORGET.
 */
export type DeviceRow =
  | { readonly source: 'account'; readonly device: AccountDevice; readonly admittedHere: boolean }
  | { readonly source: 'admitted'; readonly admitted: AdmittedPhone }
  | { readonly source: 'watch' }

/** The watch paired with this machine: its account id when the relay named it, null on a six-digit LAN claim. */
export interface WatchHere {
  readonly paired: boolean
  readonly deviceId: string | null
}

export function deviceRows(
  devices: readonly AccountDevice[],
  admitted: readonly AdmittedPhone[],
  watch: WatchHere,
): readonly DeviceRow[] {
  const onAccount = new Set(devices.map((device) => device.id))
  const admittedIds = new Set(admitted.map((phone) => phone.deviceId))
  const accountRows: DeviceRow[] = devices.map((device) => ({
    source: 'account',
    device,
    admittedHere: admittedIds.has(device.id),
  }))
  const seen = new Set<string>()
  const localRows: DeviceRow[] = admitted
    .filter((phone) => {
      if (onAccount.has(phone.deviceId) || seen.has(phone.deviceId)) return false
      seen.add(phone.deviceId)
      return true
    })
    .map((phone) => ({ source: 'admitted', admitted: phone }))
  // BY ID, NEVER BY KIND: the account may list another watch. Only the account
  // row with this watch's own id stands for it; with no id (a LAN claim) the
  // local row is the only one that can say it is here, and forget it.
  const watchListed = watch.deviceId !== null && onAccount.has(watch.deviceId)
  const watchRows: DeviceRow[] = watch.paired && !watchListed ? [{ source: 'watch' }] : []
  return [...accountRows, ...localRows, ...watchRows]
}
