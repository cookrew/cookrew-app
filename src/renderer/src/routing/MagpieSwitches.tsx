import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { MAGPIE_SWITCH_COPY } from '../../../shared/account-guide-copy'
import { LAUNCH_ENV, type LiveValues } from '../../../shared/launch-settings'
import { openMagpieCard } from './magpie-card'
import '../first-run/first-run.css'

/**
 * THE TWO MAGPIE SWITCHES: use Magpie at all, and use another computer's Magpie.
 * Both are live (main/launch-settings.ts · LIVE_KEYS): saved and applied at once,
 * no restart. Drawn in Launch settings and in the first-run guide, the same view.
 * "Open Magpie settings" starts Magpie's own page and opens it in a card, so all
 * of Magpie (accounts, keys, groups, a Remote magpie provider) is configured here.
 */

export interface MagpieSwitchesViewProps {
  values: LiveValues
  /** Held by a variable from this launch. */
  pinned: readonly ('magpie' | 'magpieRemote')[]
  /** Magpie is on this computer at all. */
  installed: boolean
  busy: boolean
  problem: string | null
  onSet: (values: Partial<LiveValues>) => void
  onConfigure: () => void
  /** `sheet` wears Launch settings' own rows; `guide` the first-run page's. */
  variant?: 'guide' | 'sheet'
}

type CheckProps = { checked: boolean; disabled: boolean; label: string; note: string; held: string | null; onChange: (on: boolean) => void; name: string; variant: 'guide' | 'sheet' }

function Check({ checked, disabled, label, note, held, onChange, name, variant }: CheckProps): React.JSX.Element {
  const input = <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  if (variant === 'sheet') {
    return (
      <div className="ls-field">
        <label className="ls-switch">
          {input}
          <span>{label}</span>
        </label>
        <p className="gs-hint">{note}</p>
        {held && <p className="gs-hint">{held}</p>}
      </div>
    )
  }
  return (
    <label className="fr-check mg-check">
      {input}
      <span>
        {label}
        <small>{note}</small>
        {held && <small className="fr-note">{held}</small>}
      </span>
    </label>
  )
}

export function MagpieSwitchesView({ values, pinned, installed, busy, problem, onSet, onConfigure, variant = 'guide' }: MagpieSwitchesViewProps): React.JSX.Element {
  const small = variant === 'sheet' ? 'gs-hint' : undefined
  const held = (key: 'magpie' | 'magpieRemote'): string | null => (pinned.includes(key) ? MAGPIE_SWITCH_COPY.PINNED(LAUNCH_ENV[key]) : null)
  return (
    <div className="mg-switches" data-magpie={values.magpie ? 'on' : 'off'} data-remote={values.magpieRemote ? 'on' : 'off'}>
      <Check variant={variant} name="magpie" checked={values.magpie} disabled={busy || pinned.includes('magpie')} label={MAGPIE_SWITCH_COPY.USE} note={MAGPIE_SWITCH_COPY.USE_NOTE} held={held('magpie')} onChange={(on) => onSet({ magpie: on })} />
      <Check
        variant={variant}
        name="magpieRemote"
        checked={values.magpie && values.magpieRemote}
        disabled={busy || !values.magpie || pinned.includes('magpieRemote')}
        label={MAGPIE_SWITCH_COPY.REMOTE}
        note={values.magpie ? MAGPIE_SWITCH_COPY.REMOTE_NOTE : MAGPIE_SWITCH_COPY.REMOTE_NEEDS}
        held={held('magpieRemote')}
        onChange={(on) => onSet({ magpieRemote: on })}
      />
      {values.magpie && (
        <div className="mg-configure">
          <button type="button" className={variant === 'sheet' ? 'gs-ghost' : 'fr-fix'} disabled={busy || !installed} onClick={onConfigure}>
            {busy ? MAGPIE_SWITCH_COPY.CONFIGURING : MAGPIE_SWITCH_COPY.CONFIGURE}
          </button>
          <small className={small}>{installed ? MAGPIE_SWITCH_COPY.CONFIGURE_NOTE : MAGPIE_SWITCH_COPY.NOT_INSTALLED}</small>
        </div>
      )}
      <small className={small ?? 'fr-why'}>{MAGPIE_SWITCH_COPY.LIVE}</small>
      {problem && (
        <p className="fr-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

/** The switches as they are now, kept current by main's push. Null until read, or on a bridge without them. */
export function useMagpieSwitches(): { values: LiveValues | null; pinned: readonly ('magpie' | 'magpieRemote')[] } {
  const [values, setValues] = useState<LiveValues | null>(null)
  const [pinned, setPinned] = useState<readonly ('magpie' | 'magpieRemote')[]>([])
  useEffect(() => {
    const api = cookrew()
    let live = true
    void api
      .launchLive?.()
      .then((next) => live && next && setValues(next))
      .catch(() => undefined)
    void api
      .launchSettings?.()
      .then((status) => live && status && setPinned(status.pinned.filter((key): key is 'magpie' | 'magpieRemote' => key === 'magpie' || key === 'magpieRemote')))
      .catch(() => undefined)
    const off = api.onLaunchLive?.((next) => live && setValues(next))
    return () => {
      live = false
      off?.()
    }
  }, [])
  return { values, pinned }
}

/** Absent where the bridge has no switches (the phone, an older desktop). */
export function MagpieSwitches({ installed, variant = 'guide' }: { installed: boolean; variant?: 'guide' | 'sheet' }): React.JSX.Element | null {
  const { values, pinned } = useMagpieSwitches()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (values === null || typeof cookrew().setLaunchLive !== 'function') return null
  return (
    <MagpieSwitchesView
      variant={variant}
      values={values}
      pinned={pinned}
      installed={installed}
      busy={busy}
      problem={problem}
      onSet={(next) => {
        setProblem(null)
        void cookrew()
          .setLaunchLive?.(next)
          .then((answer) => {
            if (!answer.ok) setProblem('Could not save the Magpie switch.')
          })
          .catch(() => setProblem('Could not save the Magpie switch.'))
      }}
      onConfigure={() => {
        setBusy(true)
        setProblem(null)
        void cookrew()
          .magpieWebOpen?.()
          .then(async (answer) => {
            if (!answer.ok) return setProblem(answer.why)
            await openMagpieCard(answer.url)
          })
          .catch(() => setProblem('Could not open Magpie’s settings.'))
          .finally(() => setBusy(false))
      }}
    />
  )
}
