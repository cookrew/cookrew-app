import { useEffect, useSyncExternalStore } from 'react'
import type { VersionWatch } from './console-version'

/**
 * ONE LINE WHEN A NEWER CONSOLE IS OUT (console-version.ts). It is asked when
 * the page is opened and each time it comes back to the front. The new build
 * loads when the button is pressed and at no other time: this page does not
 * reload under its person.
 */
export function NewerBuildView({ newer, updating, onUpdate }: { newer: boolean; updating: boolean; onUpdate: () => void }): React.JSX.Element | null {
  if (!newer) return null
  return (
    <p className="cd-newer" role="status">
      <span>{updating ? 'Updating…' : 'A newer console is ready.'}</span>
      {!updating && (
        <button type="button" className="cd-newer-go" onClick={onUpdate}>
          Update
        </button>
      )}
    </p>
  )
}

export function NewerBuild({ watch }: { watch: VersionWatch }): React.JSX.Element | null {
  const state = useSyncExternalStore(watch.subscribe, watch.get, watch.get)
  useEffect(() => {
    const ask = (): void => {
      if (document.visibilityState === 'visible') void watch.check()
    }
    ask()
    document.addEventListener('visibilitychange', ask)
    return () => document.removeEventListener('visibilitychange', ask)
  }, [watch])
  return <NewerBuildView newer={state.newer} updating={state.updating} onUpdate={() => void watch.update()} />
}
