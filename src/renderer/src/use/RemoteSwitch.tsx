import { useEffect, useState } from 'react'
import type { RemoteControlFacts } from '../../../shared/remote-access'
import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { accessOf } from './remote-acts'

/**
 * THE MACHINE SWITCH: "Allow remote control of this Mac", off by default.
 *
 * Only the Mac's own window has setRemoteSwitch (preload); a phone has no such
 * method and main has no route, so a device elsewhere sees where it stands and
 * nothing it could press. Linux has nothing to switch: its screens are view only.
 */

export const SWITCH_LABEL = 'Allow remote control of this Mac'
export const SWITCH_MEANS = 'Your paired devices can take control of a card for 15 minutes, and agents can click and type on this Mac. It stays on until Cookrew restarts, and someone at the Mac can stop it at any time.'

export function useRemoteSwitch(active: boolean, onFlipped?: () => void): { facts: RemoteControlFacts | null; error: string | null; flip: () => void } {
  const [facts, setFacts] = useState<RemoteControlFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    void cookrew().remoteAccess?.().then((answer) => setFacts(accessOf(answer)?.control ?? null)).catch(() => undefined)
  }, [active])
  const flip = (): void => {
    if (!facts) return
    const on = !facts.switchOn
    void cookrew()
      .setRemoteSwitch?.(on)
      .then((answer) => {
        setError(answer.ok ? null : answer.error)
        if (!answer.ok) return
        setFacts({ ...facts, switchOn: on })
        onFlipped?.()
      })
  }
  return { facts, error, flip }
}

/** The ⋯ menu's row. */
export function RemoteSwitchRow(): React.JSX.Element | null {
  const settable = typeof cookrew().setRemoteSwitch === 'function'
  const { facts, flip } = useRemoteSwitch(settable)
  if (!settable || !facts?.available) return null
  return (
    <button type="button" className={`cr-more-item${facts.switchOn ? ' on' : ''}`} role="switch" aria-checked={facts.switchOn} title={SWITCH_MEANS} onClick={flip}>
      <CrIcon name="select" />
      <span className="cr-more-label">{facts.switchOn ? 'Remote control: on' : SWITCH_LABEL}</span>
    </button>
  )
}
