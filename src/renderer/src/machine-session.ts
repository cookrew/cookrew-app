/**
 * WHAT RUNS FOR AS LONG AS ONE MACHINE IS IN SCOPE, and stops when it is left.
 *
 * Two things were started once at boot and never stopped, because a page had
 * one machine for life (main.tsx):
 *
 *   the path switcher   looks for a nearer way to THIS machine and moves the
 *                       data plane onto it (path/companion.ts). Left running
 *                       it would go on racing for the last machine.
 *   the build watch     reloads a page whose machine has since served a newer
 *                       build (build-watch.ts). It only makes sense on a
 *                       machine's own page: there the page IS that machine's
 *                       build. The console is its own build, hosted elsewhere,
 *                       and a machine on another one is no reason to reload it.
 *
 * Started here for the machine in scope, stopped in the phase that stops what
 * talks, and started again once the next machine is in scope. On a machine's
 * own page the scope never changes, so this runs exactly once, as before.
 */
import { cookrew, isRemoteMode } from './api'
import { watchBuild } from './build-watch'
import { machineScope, registerScopeState, scopeNeedsMachine, subscribeMachineScope } from './machine-scope'
import { startCompanionPathSwitch } from './path/companion'

let stop: (() => void) | null = null

function begin(): () => void {
  const offs: Array<() => void> = [startCompanionPathSwitch()]
  const onBuild = !scopeNeedsMachine() && isRemoteMode() ? cookrew().onBuild : undefined
  if (onBuild) {
    offs.push(
      watchBuild({
        onBuild,
        reload: () => window.location.reload(),
        onVisibility: (cb) => {
          document.addEventListener('visibilitychange', cb)
          return () => document.removeEventListener('visibilitychange', cb)
        }
      })
    )
  }
  return () => offs.forEach((off) => off())
}

/** Is there a machine to run for: always on a machine's own page, on the console only once one is entered. */
const hasMachine = (): boolean => !scopeNeedsMachine() || machineScope().machineId !== null

/** Start what runs for the machine in scope. Called once at boot; a second call restarts it. */
export function startMachineSession(): void {
  stop?.()
  stop = hasMachine() ? begin() : null
}

registerScopeState(
  'machine session',
  () => {
    stop?.()
    stop = null
  },
  'stop'
)
// The next machine is in scope by the time this is heard.
subscribeMachineScope(() => startMachineSession())
