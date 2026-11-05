// WHAT TMUX KNEW WHEN A PANE DIED.
//
// tmux takes a pane with the command that failed, and its exit status and last
// screen with it. `remain-on-exit failed` holds a pane that ended badly; this
// hook writes down its status and screen and closes it, so everything after
// that is as it always was: session gone, attach client out, `new-session -A`
// boots afresh. A clean exit is not held, and a pane Cookrew kills never fires
// `pane-died`, so a record only ever means something went wrong. It also works
// with the app closed, and with no mirror attached.
//
// herdr reports no exit status at all (no field, no event: checked on 0.9.0),
// so there the mirror's own tail is all there is.

import { constants } from 'node:os'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cleanTail } from './launch-check'
import { COOKREW_SESSION_RE } from './tmux-multiplexer'

const SCRIPT = 'pane-exit.sh'
const RECORDS = 'pane-exits'

/** `$1` socket, `$2` session, `$3` status, `$4` signal. Written whole, then moved: a half record is no record. */
const HOOK_SCRIPT = `#!/bin/sh
dir="$(dirname "$0")/${RECORDS}"
mkdir -p "$dir" || exit 0
tmp="$dir/.$2.$$"
{ printf '%s\\n%s\\n' "$3" "$4"; tmux -S "$1" capture-pane -p -t "=$2:" -S -200; } > "$tmp" && mv "$tmp" "$dir/$2"
`

export function installPaneExitHook(runtimeDir: string): void {
  const script = path.join(runtimeDir, SCRIPT)
  writeFileSync(script, HOOK_SCRIPT)
  chmodSync(script, 0o755)
}

/** A path as a tmux double-quoted word inside a single-quoted hook. */
const quoted = (text: string): string => text.replace(/[\\"$]/g, '\\$&').replace(/'/g, `'\\''`)

/**
 * The conf lines. `kill-pane` follows whatever the script did: a hook that fails
 * must not leave a dead pane for `new-session -A` to attach to forever. tmux
 * before 3.2 has no `failed`, and a config error there opens over the first pane,
 * so it is not even asked: those panes end as they always did.
 */
export function paneExitConf(runtimeDir: string): string[] {
  const script = quoted(path.join(runtimeDir, SCRIPT))
  return [
    '%if "#{>=:#{version},3.2}"',
    'set -wg remain-on-exit failed',
    `set-hook -g pane-died 'run-shell "sh \\"${script}\\" \\"#{socket_path}\\" \\"#{session_name}\\" \\"#{pane_dead_status}\\" \\"#{pane_dead_signal}\\""; kill-pane'`,
    '%endif'
  ]
}

export interface PaneExit {
  exitCode: number | null
  /** "kill", "segv". */
  signal: string | null
  tail: string[]
}

const number = (text: string | undefined): number | null => {
  const value = Number.parseInt(text ?? '', 10)
  return Number.isNaN(value) ? null : value
}

/** tmux spells a signal by name or by number, depending on its version: this is always the name. */
export function signalName(raw: string): string {
  const named = Object.entries(constants.signals).find(([, value]) => String(value) === raw)?.[0]
  return named ? named.replace(/^SIG/, '').toLowerCase() : raw
}

/** A session's death record, read once: the next wake must not repeat it. */
export function takePaneExit(runtimeDir: string, session: string): PaneExit | null {
  if (!COOKREW_SESSION_RE.test(session)) return null
  const file = path.join(runtimeDir, RECORDS, session)
  if (!existsSync(file)) return null
  try {
    const [status, signal, ...screen] = readFileSync(file, 'utf8').split('\n')
    rmSync(file, { force: true })
    return { exitCode: number(status), signal: signal ? signalName(signal) : null, tail: cleanTail(screen.join('\n')) }
  } catch (error) {
    console.error(`Reading the exit record of ${session} failed:`, error)
    return null
  }
}
