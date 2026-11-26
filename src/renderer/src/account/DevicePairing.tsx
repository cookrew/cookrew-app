import { useCallback, useEffect, useState } from 'react'
import { hostPlatform, machineCopy } from '../../../shared/machine-words'
import { cookrew } from '../api'
import { WatchPairSheet } from '../WatchPairSheet'
import { PairPhoneSheet } from './PairPhoneSheet'
import type { WatchHere } from './device-rows'

/**
 * EVERY WAY TO ADD A DEVICE, IN ONE ROW at the top of the Devices tab: a watch,
 * a phone, a new Mac. Each opens the ceremony that device already has —
 * WatchPairSheet (the watch types a code), PairPhoneSheet (the phone scans
 * this machine's console address) and the account's join code for a new Mac,
 * which the sheet itself draws because it is minted under step-up there.
 *
 * ONE PHONE VERB. The account join code used to be offered to phones too
 * (ADD A PHONE), beside PAIR A PHONE: two buttons for one device, and only the
 * scan opens this machine for it. A phone signs in to the account on the
 * console the scan opens, so the join code had nothing left to do for it.
 */
export function DevicePairing({
  disabled,
  addingMac,
  onAddMac,
  onChanged,
}: {
  readonly disabled: boolean
  readonly addingMac: boolean
  readonly onAddMac: () => void
  /** A pairing sheet closed: the lists below may have a new device. */
  readonly onChanged: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState<'phone' | 'watch' | null>(null)
  const canPairWatch = cookrew().watchCode !== undefined
  const close = (): void => {
    setOpen(null)
    onChanged()
  }
  return (
    <>
      <p className="cr-acct-devices-heading">Pair a device</p>
      <div className="cr-acct-row cr-acct-add">
        {canPairWatch && (
          <button className="gs-ghost" disabled={disabled} onClick={() => setOpen('watch')}>
            PAIR A WATCH
          </button>
        )}
        <button className="gs-ghost" disabled={disabled} onClick={() => setOpen('phone')}>
          PAIR A PHONE
        </button>
        <button className="gs-ghost" disabled={disabled} aria-expanded={addingMac} onClick={onAddMac}>
          {machineCopy('PAIR A NEW MAC', hostPlatform())}
        </button>
      </div>
      {open === 'phone' && <PairPhoneSheet onClose={close} />}
      {open === 'watch' && <WatchPairSheet over onClose={close} />}
    </>
  )
}

/**
 * Whether a watch is paired with THIS machine, and the verb that forgets it.
 * `seen` is bumped by the caller when a pairing sheet closes, so a watch paired
 * a moment ago is on the list without reopening the tab.
 */
export function useWatchHere(seen: number): WatchHere & { readonly forget: () => Promise<boolean> } {
  const api = cookrew()
  const [here, setHere] = useState<WatchHere>(NOT_PAIRED)
  useEffect(() => {
    let live = true
    void api.watchState?.().then(
      (state) => {
        if (live) setHere({ paired: state.paired, deviceId: state.deviceId ?? null })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [api, seen])
  const forget = useCallback(async (): Promise<boolean> => {
    const call = api.watchForget
    if (!call) return false
    try {
      await call()
      setHere(NOT_PAIRED)
      return true
    } catch {
      return false
    }
  }, [api])
  return { ...here, forget }
}

const NOT_PAIRED: WatchHere = { paired: false, deviceId: null }
