import { useEffect, useState } from 'react'
import { hostPlatform, machineCopy } from '../../../shared/machine-words'
import type { RemoteAnswer, RemoteControlFacts } from '../../../shared/remote-access'
import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { accessOf } from './remote-acts'

/**
 * THE MACHINE SWITCH: "Allow remote control of this Mac", off by default.
 *
 * Only the machine's own window has setRemoteSwitch (preload); a phone has no
 * such method and main has no route, so a device elsewhere sees where it stands
 * and nothing it could press. A Linux X11 machine has the same switch (and
 * `cookrew remote on` in a shell on it); nothing on Linux is unlocked.
 */

export const SWITCH_LABEL = 'Allow remote control of this Mac'
export const SWITCH_MEANS = 'Your paired devices can unlock this Mac with its password and take control of a card for 15 minutes, and agents can click and type on this Mac. It stays on after a restart until you turn it off here, keeps this Mac awake while its lid is open, and someone at the Mac can stop it at any time.'
const LINUX_SWITCH_MEANS = 'Your paired devices can take control of a card for 15 minutes, and agents can click and type on this machine. It stays on until you turn it off here or with cookrew remote off, and someone at the machine can stop it at any time.'

/** The switch's words for the machine it is on: this window's own platform unless told. */
export function switchWords(platform: string | undefined = hostPlatform()): { readonly label: string; readonly means: string } {
  return { label: machineCopy(SWITCH_LABEL, platform), means: platform === 'linux' ? LINUX_SWITCH_MEANS : machineCopy(SWITCH_MEANS, platform) }
}

/** What was pressed is what is sent: two surfaces show this switch, and either may be behind the other. */
export const switchAnswer = (set: (on: boolean) => Promise<RemoteAnswer>, on: boolean): Promise<RemoteAnswer> => set(on)

export function useRemoteSwitch(active: boolean, onFlipped?: () => void): { facts: RemoteControlFacts | null; error: string | null; busy: boolean; flip: (on: boolean) => void } {
  const [facts, setFacts] = useState<RemoteControlFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!active) return
    void cookrew().remoteAccess?.().then((answer) => setFacts(accessOf(answer)?.control ?? null)).catch(() => undefined)
  }, [active])
  const flip = (on: boolean): void => {
    const set = cookrew().setRemoteSwitch
    if (!set || busy) return
    setBusy(true)
    void switchAnswer(set, on).then((answer) => {
      setError(answer.ok ? null : answer.error)
      // A refusal can still mean it moved: on for this run, and not saved.
      if (!answer.ok) return void cookrew().remoteAccess?.().then((next) => setFacts(accessOf(next)?.control ?? null))
      setFacts((now) => (now ? { ...now, switchOn: on } : now))
      onFlipped?.()
    }).finally(() => setBusy(false))
  }
  return { facts, error, busy, flip }
}

/** The ⋯ menu's row. */
export function RemoteSwitchRow(): React.JSX.Element | null {
  const settable = typeof cookrew().setRemoteSwitch === 'function'
  const { facts, busy, flip } = useRemoteSwitch(settable)
  if (!settable || !facts?.available) return null
  const words = facts.switchOn ? facts.unlockWords?.join(' ') : undefined
  const { label, means } = switchWords()
  return (
    <button type="button" disabled={busy} className={`cr-more-item${words ? ' tall' : ''}${facts.switchOn ? ' on' : ''}`} role="switch" aria-checked={facts.switchOn} title={means} onClick={() => flip(!facts.switchOn)}>
      <CrIcon name="select" />
      <span className="cr-more-text">
        <span className="cr-more-label">{facts.switchOn ? 'Remote control: on' : label}</span>
        {words && <span className="cr-more-note">Unlock key: {words}</span>}
      </span>
    </button>
  )
}
