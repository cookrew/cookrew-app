import { describe, expect, it } from 'vitest'
import { deviceRows } from '../src/renderer/src/account/device-rows'
import type { AccountDevice, AdmittedPhone } from '../src/shared/account-v2'

const device = (id: string, kind: AccountDevice['kind'], name: string, current = false): AccountDevice => ({
  id,
  kind,
  name,
  addedAt: 1,
  lastSeenAt: 2,
  current,
})
const admitted = (deviceId: string, name?: string): AdmittedPhone => ({
  deviceId,
  ...(name ? { name } : {}),
  admittedAt: 1,
  lastSeenAt: 3,
})
const NO_WATCH = { paired: false, deviceId: null }

describe('the Devices tab lists each device once', () => {
  const account = [
    device('mac', 'desktop', 'MacBook Pro', true),
    device('solis', 'desktop', 'Solis-Core'),
    device('android', 'phone', 'Console on Android phone'),
    device('watch', 'watch', 'Apple Watch'),
  ]

  it('folds a device admitted here into its account row', () => {
    const rows = deviceRows(account, [admitted('solis', 'Solis-Core'), admitted('android', 'Console on Android phone')], NO_WATCH)
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.source === 'account')).toBe(true)
    const solis = rows.find((row) => row.source === 'account' && row.device.id === 'solis')
    expect(solis).toMatchObject({ admittedHere: true })
    const mac = rows.find((row) => row.source === 'account' && row.device.id === 'mac')
    expect(mac).toMatchObject({ admittedHere: false })
  })

  it('keeps a device only this machine knows, once, after the account rows', () => {
    const rows = deviceRows(account, [admitted('stranger', 'Old iPhone'), admitted('stranger', 'Old iPhone')], NO_WATCH)
    expect(rows).toHaveLength(5)
    expect(rows[4]).toEqual({ source: 'admitted', admitted: admitted('stranger', 'Old iPhone') })
  })

  it('folds the watch paired here into the account row with its id, and only that one', () => {
    const watchRows = (watch: { paired: boolean; deviceId: string | null }) =>
      deviceRows(account, [], watch).filter((row) => row.source === 'watch')
    expect(watchRows({ paired: true, deviceId: 'watch' })).toHaveLength(0)
    // Another watch of the account is not this Mac's: this one keeps its row and its FORGET.
    expect(watchRows({ paired: true, deviceId: 'another-watch' })).toEqual([{ source: 'watch' }])
    // Paired by six digits on the LAN: no account id to match, so it is never hidden.
    expect(watchRows({ paired: true, deviceId: null })).toEqual([{ source: 'watch' }])
    expect(watchRows({ paired: false, deviceId: null })).toHaveLength(0)
  })

  it('lists admitted devices on their own while the account list is not read yet', () => {
    const rows = deviceRows([], [admitted('a', 'Phone A')], NO_WATCH)
    expect(rows).toEqual([{ source: 'admitted', admitted: admitted('a', 'Phone A') }])
  })
})
